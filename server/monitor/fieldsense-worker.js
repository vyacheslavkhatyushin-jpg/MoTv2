/*
FieldSense (FlexAlertTTE) — поиск обрыва кабеля, коллектор мониторинга для
оборудования типа FS (см. docs/monitoring-plan.md). Тот же физический сервер
и тот же логин/пароль, что у SPPD (project_sppd_config) — просто другой
раздел того же Django-сайта, поэтому логин переиспользуется из
sppd-worker.js, а не дублируется.

В отличие от sppd-worker (постоянный WebSocket, push), у FieldSense нет
API — это обычная серверная HTML-страница /FlexAlertTTE/fieldsense/ с
таблицей "Датчики". Поэтому здесь простой поллинг по таймеру: GET страницы
по сессионной куке, разбор HTML-таблицы регуляркой (без cheerio — в проекте
такой зависимости нет, а верстка простая и стабильная), сопоставление по
номеру "#" (тот же принцип, что sppdAddress у SPPD — админ один раз
прописывает номер датчика на объекте FS в редакторе).

Статус ("На связи"/иное) на этой странице уже вычислен сервером
FlexAlertTTE — доверяем ему напрямую, как OnLine у SPPD: applyOnlineState
(импортирован из sppd-worker.js) красит статус сразу и debounce'ит запись
аварии по тому же per-project порогу (project_monitor_thresholds,
sppd_fail_duration_sec — общий с SPPD, отдельного порога для FieldSense
пока нет).
*/
const db = require("../db");
const sppd = require("./sppd-worker");

const POLL_INTERVAL_MS = parseInt(process.env.FIELDSENSE_POLL_INTERVAL_MS || "60000", 10);
const SESSION_TTL_MS = parseInt(process.env.FIELDSENSE_SESSION_TTL_MS || String(6 * 3600 * 1000), 10);
const CONFIG_REFRESH_MS = parseInt(process.env.FIELDSENSE_CONFIG_REFRESH_MS || "60000", 10);
const FIELDSENSE_PATH = "/FlexAlertTTE/fieldsense/";
const DEBUG = process.env.FIELDSENSE_DEBUG === "1";

/* ---------- цели: оборудование с monitorMethod:"fs" ---------- */
function collectFsTargets(projectId) {
  const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  const byAddr = new Map();
  if (!row) return byAddr;
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch (err) {
    console.error(`[fieldsense-worker] bad snapshot_json for project ${projectId}:`, err.message);
    return byAddr;
  }
  for (const eq of snapshot.equipment || []) {
    if (eq.monitorMethod !== "fs" || !eq.fsAddress) continue;
    const addr = String(eq.fsAddress);
    if (!byAddr.has(addr)) byAddr.set(addr, []);
    byAddr.get(addr).push({ projectId, equipmentId: eq.id, label: eq.label });
  }
  return byAddr;
}

/* ---------- разбор таблицы "Датчики" ----------
   Строки: # | Антенна | Номер измерения | Время | Место установки |
   Уровень заряда | Статус. Верстка сервера FlexAlertTTE — обычные <tr>/<td>,
   без классов/data-атрибутов, поэтому парсим регуляркой по тегам, а не по
   селекторам. Первая ячейка — число (#), последняя — статус текстом. */
function parseFieldsenseHtml(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html))) {
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(trMatch[1]))) {
      cells.push(
        cellMatch[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      );
    }
    // Заголовок таблицы и строка "Базовая станция" не начинаются с числа в
    // первой ячейке — этого достаточно, чтобы отсечь их без явного поиска
    // заголовка по тексту (который может отличаться в разных версиях страницы).
    if (cells.length < 2 || !/^\d+$/.test(cells[0])) continue;
    // Колонки: # | Антенна | Номер измерения | Время | Место установки |
    // Уровень заряда | Статус — "Место установки" пятая по счёту (индекс 4).
    rows.push({ addr: cells[0], place: cells[4] || null, status: cells[cells.length - 1] });
  }
  return rows;
}

function isOnlineStatus(status) {
  return /на связи/i.test(status || "");
}

async function fetchFieldsenseRows(baseUrl, sessionCookie) {
  const resp = await fetch(`${baseUrl}${FIELDSENSE_PATH}`, {
    headers: { Cookie: sessionCookie },
    redirect: "manual",
  });
  // Django обычно редиректит на /login/, когда сессия протухла, но на
  // случай другого поведения (200 с формой логина вместо таблицы)
  // дополнительно проверяем содержимое ниже.
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error("session_expired");
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const html = await resp.text();
  if (!/Датчики/i.test(html) && /csrfmiddlewaretoken/i.test(html)) {
    throw new Error("session_expired");
  }
  return parseFieldsenseHtml(html);
}

/* ---------- один "сайт" — проект + опрос его FieldSense-страницы ---------- */
function startSite(projectId, config) {
  let closed = false;
  let sessionCookie = null;
  let targetsByAddr = collectFsTargets(projectId);

  async function ensureSession() {
    if (sessionCookie) return sessionCookie;
    sessionCookie = await sppd.login(config);
    console.log(`[fieldsense-worker] [${projectId}] logged in`);
    return sessionCookie;
  }

  async function poll() {
    if (closed || !targetsByAddr.size) return;
    try {
      await ensureSession();
      const rows = await fetchFieldsenseRows(config.baseUrl, sessionCookie);
      if (DEBUG) {
        console.log(`[fieldsense-worker] [${projectId}] ${rows.length} row(s) parsed`);
      }
      for (const row of rows) {
        const targets = targetsByAddr.get(row.addr);
        if (DEBUG) {
          console.log(`[fieldsense-worker] [${projectId}] # ${row.addr} status="${row.status}" matched=${targets ? targets.length : 0}`);
        }
        if (!targets || !targets.length) continue;
        const online = isOnlineStatus(row.status);
        const metrics = row.place ? { place: row.place } : null;
        for (const target of targets) sppd.applyOnlineState(target, online, metrics);
      }
    } catch (err) {
      if (err.message === "session_expired") {
        sessionCookie = null;
        console.log(`[fieldsense-worker] [${projectId}] session expired — will re-login on next poll`);
      } else {
        console.error(`[fieldsense-worker] [${projectId}] poll failed:`, err.message);
      }
    }
  }

  const targetTimer = setInterval(() => {
    if (!closed) targetsByAddr = collectFsTargets(projectId);
  }, POLL_INTERVAL_MS);
  const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Session TTL — просто сбрасываем куку, ensureSession() перелогинится на
  // следующем poll(), тем же способом, что и при "session_expired".
  const reloginTimer = setInterval(() => {
    sessionCookie = null;
  }, SESSION_TTL_MS);
  poll();

  return {
    config,
    stop() {
      closed = true;
      clearInterval(targetTimer);
      clearInterval(pollTimer);
      clearInterval(reloginTimer);
    },
  };
}

async function run() {
  const sites = new Map(); // projectId -> { config, stop() }

  function refresh() {
    const configs = sppd.loadSiteConfigs();
    for (const [projectId, site] of sites) {
      if (!configs.has(projectId) || !sppd.sameConfig(site.config, configs.get(projectId))) {
        console.log(`[fieldsense-worker] [${projectId}] config removed/changed — stopping site`);
        site.stop();
        sites.delete(projectId);
      }
    }
    for (const [projectId, config] of configs) {
      if (!sites.has(projectId)) {
        console.log(`[fieldsense-worker] [${projectId}] starting site (base=${config.baseUrl})`);
        sites.set(projectId, startSite(projectId, config));
      }
    }
  }

  refresh();
  setInterval(refresh, CONFIG_REFRESH_MS);
}

if (require.main === module) {
  console.log("[fieldsense-worker] starting — reading per-project config from project_sppd_config");
  run();
}

module.exports = { collectFsTargets, parseFieldsenseHtml, isOnlineStatus, fetchFieldsenseRows };
