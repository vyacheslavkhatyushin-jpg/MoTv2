/*
FieldSense (FlexAlertTTE) — поиск обрыва кабеля, коллектор мониторинга для
оборудования типа FS (см. docs/monitoring-plan.md). Живёт на том же
физическом сервере, что и SPPD, использует тот же логин/пароль
(project_sppd_config переиспользуется, отдельной настройки нет) — но это
отдельный бэкенд ("fatte"), не тот же Django-процесс, что SPPD:

  - страница /FlexAlertTTE/fieldsense/ отдаёт ТОЛЬКО пустой каркас таблицы
    "Датчики" (номер #, антенна, место установки — без статуса/времени/
    заряда, они пустые в исходном HTML) — все живые данные подгружает
    браузерный JS через WebSocket, поэтому обычный HTTP GET+regex-парсинг
    HTML (первая версия этого воркера) не работал: статус всегда был пустой.

  - реальный источник — ws://<host>/fatte/api/ws/fieldsense, сообщения в
    том же конверте {WSM_TYPE, WSM_DATA}, что у SPPD/SBeacon (обнаружено
    через вкладку Network в devtools на живой системе):
      {"WSM_TYPE":"SENSOR","WSM_DATA":{"bs_id":1,"sensor_id":119,"status":0,"battery_lvl":0,...}}
    sensor_id — тот же номер, что колонка "#" в таблице "Датчики".
    status: 1 — "На связи", 0 — "Нет связи" (подтверждено на живой системе).

  - авторизация этого WS — ОТДЕЛЬНАЯ кука PHPSESSID (PHP-сессия), а не
    Django sessionid/csrftoken у SPPD. На практике она приходит тем же
    логином (POST /login/ выдаёт её вместе с sessionid/csrftoken —
    видно на живой системе), но login() в sppd-worker.js раньше явно
    оставлял только csrftoken/sessionid и терял остальные куки — это
    починено в sppd-worker.js (login() теперь возвращает все куки с
    ответа). Если по какой-то причине PHPSESSID всё же не пришёл с тем
    же логином, ensureSession() ниже дополнительно "прогревает" сессию
    GET-запросом на /FlexAlertTTE/fieldsense/ и подхватывает PHPSESSID
    из его Set-Cookie, если он появится там.

connectStream()/login()/parseSetCookiePairs()/applyOnlineState() — общий
код с sppd-worker.js, импортированы оттуда, а не продублированы.
*/
const db = require("../db");
const sppd = require("./sppd-worker");

const SESSION_TTL_MS = parseInt(process.env.FIELDSENSE_SESSION_TTL_MS || String(6 * 3600 * 1000), 10);
const CONFIG_REFRESH_MS = parseInt(process.env.FIELDSENSE_CONFIG_REFRESH_MS || "60000", 10);
const TARGET_REFRESH_MS = parseInt(process.env.FIELDSENSE_TARGET_REFRESH_MS || "30000", 10);
const WS_PATH = "/fatte/api/ws/fieldsense";
const FIELDSENSE_PAGE_PATH = "/FlexAlertTTE/fieldsense/";
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

/* ---------- логин: Django-сессия SPPD + "прогрев" PHP-сессии fatte ---------- */
async function establishSession(config) {
  const djangoCookie = await sppd.login(config);
  if (/(?:^|;\s*)PHPSESSID=/.test(djangoCookie)) {
    return djangoCookie; // уже пришёл вместе с логином — прогревать не нужно
  }
  const resp = await fetch(`${config.baseUrl}${FIELDSENSE_PAGE_PATH}`, {
    headers: { Cookie: djangoCookie },
    redirect: "manual",
  });
  const extra = sppd.parseSetCookiePairs(resp.headers);
  return extra.PHPSESSID ? `${djangoCookie}; PHPSESSID=${extra.PHPSESSID}` : djangoCookie;
}

function handleSensor(msg, targetsByAddr, siteLabel) {
  const data = msg.WSM_DATA;
  if (DEBUG) {
    console.log(`[fieldsense-worker]${siteLabel ? " [" + siteLabel + "]" : ""} SENSOR WSM_DATA=${JSON.stringify(data)}`);
  }
  if (!data || data.sensor_id === undefined || data.sensor_id === null) return;
  const addr = String(data.sensor_id);
  const targets = targetsByAddr.get(addr);
  if (DEBUG) {
    console.log(`[fieldsense-worker]${siteLabel ? " [" + siteLabel + "]" : ""} SENSOR sensor_id=${addr} status=${data.status} matched=${targets ? targets.length : 0}`);
  }
  if (!targets || !targets.length) return;
  const online = Number(data.status) === 1;
  const metrics = data.battery_lvl !== undefined ? { batteryLvl: data.battery_lvl } : null;
  for (const target of targets) sppd.applyOnlineState(target, online, metrics);
}

function logTargets(projectId, targetsByAddr) {
  const addrs = [...targetsByAddr.keys()];
  console.log(`[fieldsense-worker] [${projectId}] ${addrs.length} fs-target sensor_id(s) configured: ${addrs.join(", ") || "(none)"}`);
}

/* ---------- один "сайт" — проект + свой FlexAlertTTE-сервер ---------- */
function startSite(projectId, config) {
  const wsBase = config.baseUrl.replace(/^http/, "ws");
  let closed = false;
  let targetsByAddr = collectFsTargets(projectId);
  logTargets(projectId, targetsByAddr);
  let conn = null;
  let reloginTimer = null;
  let targetTimer = null;

  targetTimer = setInterval(() => {
    if (closed) return;
    targetsByAddr = collectFsTargets(projectId);
    if (DEBUG) logTargets(projectId, targetsByAddr);
  }, TARGET_REFRESH_MS);

  async function connect() {
    if (closed) return;
    let sessionCookie;
    try {
      sessionCookie = await establishSession(config);
      console.log(`[fieldsense-worker] [${projectId}] session established`);
    } catch (err) {
      console.error(`[fieldsense-worker] [${projectId}] login failed:`, err.message);
      if (!closed) setTimeout(connect, 3000);
      return;
    }
    if (conn) conn.close();
    function dispatch(msg) {
      const type = typeof msg.WSM_TYPE === "string" ? msg.WSM_TYPE.trim() : msg.WSM_TYPE;
      if (type === "SENSOR") handleSensor(msg, targetsByAddr, projectId);
      else if (DEBUG) {
        console.log(`[fieldsense-worker] [${projectId}] unhandled WSM_TYPE=${JSON.stringify(msg.WSM_TYPE)}`);
      }
    }
    conn = sppd.connectStream(`${projectId}/fieldsense`, wsBase, WS_PATH, sessionCookie, dispatch, () => closed);
  }

  connect();
  reloginTimer = setInterval(connect, SESSION_TTL_MS);

  return {
    config,
    stop() {
      closed = true;
      clearInterval(targetTimer);
      clearInterval(reloginTimer);
      if (conn) conn.close();
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

module.exports = { collectFsTargets, handleSensor, establishSession };
