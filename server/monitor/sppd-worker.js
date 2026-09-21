/*
SPPD/SBeacon-коллектор мониторинга (Этап 4, см. docs/monitoring-plan.md).

Отдельный процесс, как ping-worker.js — свой сервис в docker-compose, та же
SQLite через общий volume. В отличие от ping-worker (опрос по таймеру), этот
воркер держит по два постоянных WebSocket-соединения на каждый настроенный
проект и обрабатывает события по мере поступления:

  - ws://<host>/sppd/v1/ws/stream    — телеметрия устройств
  - ws://<host>/sbeacon/v1/ws/stream — счётчик меток/людей на считывателе

  Названия путей наводят на мысль, что SB_EVENT приходит на первый, а
  NOFTAG/REG_TAG — на второй, но на живой системе (проверено на apk) это
  не так: какой тип сообщения придёт на какой сокет — не гарантировано
  (реально наблюдали SB_EVENT на "sbeacon"-соединении и REG_TAG на
  "sppd"). Поэтому оба соединения разбирают сообщения одинаково, по
  WSM_TYPE, а не по тому, откуда они пришли — см. dispatch() в startSite.

  - SB_EVENT (Addr, State.OnLine, TxRx, Firmware) → online/offline для
    оборудования с monitorMethod:"sppd" (в модели это IILB/ISIB).
  - NOFTAG (Addr, NOfTag, NOfMan, NofVehicle) → person_count/vehicle_count
    того же оборудования.
  - REG_TAG (addr, в нижнем регистре — отдельное поле от Addr в остальных
    типах) → разовая "вспышка" (monitor_tag_pulses) на каждую регистрацию
    метки — точное событие, обнаружено в реальном потоке уже после
    деплоя, не задокументировано изначально.

Каждая шахта (проект apk/ipk/opk и т.п.) — это отдельный физический сервер
SPPD со своим логином/паролем, поэтому конфигурация не глобальная (env), а
per-project: таблица project_sppd_config, настраивается админом через
GET/PUT /api/projects/:id/monitor/sppd-config (server/routes/projects.js).
Воркер сам ничего не знает про конкретные project_id — раз в
SPPD_CONFIG_REFRESH_MS перечитывает эту таблицу и держит по одному
независимому "сайту" (сессия + два WS + список целей) на каждый настроенный
проект, поднимая/останавливая их при появлении/изменении/удалении записи.

Открытый вопрос из плана: общая ли нумерация Addr у SPPD и SBeacon для
одного физического считывателя. Предположение (пока не проверено на живой
системе) — общая: сопоставляем оборудование по Addr в обоих потоках через
один и тот же sppdAddress. Подтвердить/поправить после деплоя.

Аутентификация — Django-сессия: GET /login/ за csrftoken+csrfmiddlewaretoken,
POST /login/ с логином/паролем → Set-Cookie: sessionid. Сессия используется
как Cookie-заголовок при апгрейде WebSocket-соединений.
*/
const { WebSocket } = require("ws");
const db = require("../db");

const CONFIG_REFRESH_MS = parseInt(process.env.SPPD_CONFIG_REFRESH_MS || "60000", 10);
const TARGET_REFRESH_MS = parseInt(process.env.SPPD_TARGET_REFRESH_MS || "30000", 10);
const SESSION_TTL_MS = parseInt(process.env.SPPD_SESSION_TTL_MS || String(6 * 3600 * 1000), 10);
const RECONNECT_BASE_MS = parseInt(process.env.SPPD_RECONNECT_BASE_MS || "3000", 10);
const RECONNECT_MAX_MS = parseInt(process.env.SPPD_RECONNECT_MAX_MS || "30000", 10);
const TAG_PULSE_MAX_AGE_MS = parseInt(process.env.SPPD_TAG_PULSE_MAX_AGE_MS || String(2 * 60 * 1000), 10);
// SPPD — push-модель (в отличие от ping-worker, который сам активно
// стучится и получает явный отказ), поэтому если считыватель реально
// пропал, он просто перестаёт слать SB_EVENT — тишина, а не ошибка. Если
// от Addr не было НИ ОДНОГО сообщения дольше STALE_AFTER_MS — считаем это
// "Нет связи" и переводим в state:"down" сами, с записью в monitor_events.
const STALE_AFTER_MS = parseInt(process.env.SPPD_STALE_AFTER_MS || String(2 * 60 * 1000), 10);
const STALE_CHECK_MS = parseInt(process.env.SPPD_STALE_CHECK_MS || "30000", 10);
// Статус на дашборде/3D — всегда сырой (online/offline красит сразу, будь то
// явный push OnLine:false или обнаруженная тишина). "Авария" как событие в
// monitor_events фиксируется только после SPPD_FAIL_DURATION_MS непрерывного
// "down" — per-project, настраивается через ⚙ Пороги (см. getFailDurationMs).
const SPPD_FAIL_DURATION_MS = parseInt(process.env.SPPD_FAIL_DURATION_SEC || "300", 10) * 1000;
// Отладка: SPPD_DEBUG=1 логирует каждый разобранный SB_EVENT/NOFTAG (его Addr
// и попал ли он в список целей) — включать временно, когда данные почему-то
// не доходят до monitor_status, чтобы увидеть реальные Addr в потоке и
// сверить их с sppdAddress, настроенным на оборудовании.
const DEBUG = process.env.SPPD_DEBUG === "1";

/* ---------- список настроенных сайтов (проектов) ---------- */
function loadSiteConfigs() {
  const rows = db.prepare("SELECT project_id, base_url, username, password FROM project_sppd_config").all();
  const byProject = new Map();
  for (const row of rows) {
    byProject.set(row.project_id, { baseUrl: row.base_url.replace(/\/+$/, ""), username: row.username, password: row.password });
  }
  return byProject;
}

/* ---------- Django-логин: csrftoken из GET, sessionid из POST ---------- */
function parseSetCookiePairs(headers) {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : headers.raw ? headers.raw()["set-cookie"] || [] : [];
  const jar = {};
  for (const line of raw) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (m) jar[m[1]] = m[2];
  }
  return jar;
}

async function login(config) {
  const { baseUrl, username, password } = config;
  const loginPageResp = await fetch(`${baseUrl}/login/`, { redirect: "manual" });
  const loginPageHtml = await loginPageResp.text();
  const cookies1 = parseSetCookiePairs(loginPageResp.headers);
  const csrftoken = cookies1.csrftoken;
  const m = /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/.exec(loginPageHtml);
  const csrfmiddlewaretoken = m ? m[1] : null;
  if (!csrftoken || !csrfmiddlewaretoken) {
    throw new Error("Не удалось получить csrftoken/csrfmiddlewaretoken со страницы логина");
  }

  const body = new URLSearchParams({ username, password, csrfmiddlewaretoken, next: "/", login: "" });
  const postResp = await fetch(`${baseUrl}/login/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `csrftoken=${csrftoken}`,
      Referer: `${baseUrl}/login/`,
    },
    body: body.toString(),
  });
  const cookies2 = parseSetCookiePairs(postResp.headers);
  // Сохраняем ВСЕ куки с обоих ответов (не только csrftoken/sessionid) —
  // на живой системе этот же логин попутно выдаёт PHPSESSID для отдельного
  // PHP-бэкенда FieldSense/FlexAlertTTE ("fatte"), сидящего на том же хосте;
  // раньше эта кука тут терялась, и WebSocket FieldSense не мог
  // авторизоваться, даже с валидной Django-сессией.
  const merged = { ...cookies1, ...cookies2 };
  if (!merged.sessionid) {
    throw new Error(`Логин SPPD не удался (HTTP ${postResp.status}, sessionid отсутствует)`);
  }
  return Object.entries(merged)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/* ---------- сбор целей одного проекта: оборудование с monitorMethod:"sppd" ----------
   Addr -> [{equipmentId, label}] — в пределах одного проекта Addr обычно
   уникален, но массив на случай дублей в данных. */
function collectSppdTargets(projectId) {
  const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  const byAddr = new Map();
  if (!row) return byAddr;
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch (err) {
    console.error(`[sppd-worker] bad snapshot_json for project ${projectId}:`, err.message);
    return byAddr;
  }
  for (const eq of snapshot.equipment || []) {
    if (eq.monitorMethod !== "sppd" || !eq.sppdAddress) continue;
    const addr = String(eq.sppdAddress);
    if (!byAddr.has(addr)) byAddr.set(addr, []);
    byAddr.get(addr).push({ projectId, equipmentId: eq.id, label: eq.label });
  }
  return byAddr;
}

/* ---------- запись состояния в monitor_status/monitor_events ---------- */
// state + raw_metrics_json вместе — applyOnlineState() мёрджит новый патч
// метрик поверх уже сохранённых (см. mergeMetricsJson), чтобы State-событие
// без TxRx/VLine не стирало то, что пришло отдельными сообщениями раньше.
const stmtGetStatus = db.prepare("SELECT state, raw_metrics_json FROM monitor_status WHERE project_id = ? AND equipment_id = ?");
const stmtUpsertState = db.prepare(`
  INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, last_change_at, raw_metrics_json)
  VALUES (@projectId, @equipmentId, @state, @checkedAt, @changedAt, @metrics)
  ON CONFLICT(project_id, equipment_id) DO UPDATE SET
    state = @state,
    last_checked_at = @checkedAt,
    last_change_at = CASE WHEN monitor_status.state != @state THEN @changedAt ELSE monitor_status.last_change_at END,
    raw_metrics_json = @metrics
`);
const stmtUpsertCounts = db.prepare(`
  INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, person_count, vehicle_count)
  VALUES (@projectId, @equipmentId, 'unknown', @checkedAt, @personCount, @vehicleCount)
  ON CONFLICT(project_id, equipment_id) DO UPDATE SET
    last_checked_at = @checkedAt,
    person_count = @personCount,
    vehicle_count = @vehicleCount
`);
// Мёрдж патча метрик поверх уже сохранённых (а не перезапись) — иначе,
// например, VLine-сообщение стирало бы TxRx, записанный предыдущим
// сообщением на тот же Addr, и наоборот.
function mergeMetricsJson(currentRawJson, patch) {
  const current = currentRawJson ? JSON.parse(currentRawJson) : {};
  return JSON.stringify(Object.assign({}, current, patch));
}
// TxRx/Firmware/VLine у SPPD, показания каналов у точечных источников (АГС
// и т.п.) прилетают без явного "online"-сигнала рядом — раньше это писалось
// без изменения state (только raw_metrics_json), из-за чего оборудование,
// у которого нет отдельного online-поля вообще (газоанализатор — только
// показания каналов), один раз помеченное "down" по протуханию, никогда не
// возвращалось в "up", хотя данные продолжали идти. Раз сообщение вообще
// дошло и распарсилось — источник точно жив, поэтому применяем его как
// applyOnlineState(..., true, ...): выставляем "up" и закрываем открытый
// "down"-эвент, если он был.
function applyMetricsOnly(target, metricsPatch) {
  applyOnlineState(target, true, metricsPatch);
}
const stmtOpenEvent = db.prepare(`
  INSERT INTO monitor_events (project_id, equipment_id, equipment_label, from_state, to_state, started_at)
  VALUES (@projectId, @equipmentId, @label, @fromState, @toState, @startedAt)
`);
const stmtFindOpenEvent = db.prepare(`
  SELECT id, started_at FROM monitor_events
  WHERE project_id = ? AND equipment_id = ? AND ended_at IS NULL
  ORDER BY started_at DESC LIMIT 1
`);
const stmtCloseEvent = db.prepare("UPDATE monitor_events SET ended_at = ?, duration_sec = ? WHERE id = ?");
const stmtInsertTagPulse = db.prepare("INSERT INTO monitor_tag_pulses (project_id, equipment_id) VALUES (?, ?)");
const stmtCleanupTagPulses = db.prepare("DELETE FROM monitor_tag_pulses WHERE created_at < datetime('now', ?)");
// Только state/таймстемпы — в отличие от stmtUpsertState, не трогает
// raw_metrics_json/person_count/vehicle_count при обновлении: "протухшая"
// метка означает "давно нет вестей", а не "заново собранные нулевые данные".
const stmtMarkStale = db.prepare(`
  INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, last_change_at)
  VALUES (@projectId, @equipmentId, 'down', @checkedAt, @changedAt)
  ON CONFLICT(project_id, equipment_id) DO UPDATE SET
    state = 'down',
    last_checked_at = @checkedAt,
    last_change_at = CASE WHEN monitor_status.state != 'down' THEN @changedAt ELSE monitor_status.last_change_at END
`);
const stmtGetLastChecked = db.prepare("SELECT state, last_checked_at FROM monitor_status WHERE project_id = ? AND equipment_id = ?");

// Момент начала текущей непрерывной серии "down" на цель, в памяти процесса
// (см. тот же паттерн в ping-worker.js: сбрасывается при перезапуске воркера,
// не хранится в БД — это внутренний таймер debounce для события). Общий и
// для явного push OnLine:false, и для обнаруженной тишины — обе ветки идут
// через один и тот же trackDownAndMaybeOpenEvent().
const downSince = new Map(); // `${projectId}:${equipmentId}` -> ms timestamp

function trackDownAndMaybeOpenEvent(target, failDurationMs) {
  const key = target.projectId + ":" + target.equipmentId;
  const nowMs = Date.now();
  if (!downSince.has(key)) downSince.set(key, nowMs);
  const startedMs = downSince.get(key);
  if (nowMs - startedMs < failDurationMs) return;

  const openEvent = stmtFindOpenEvent.get(target.projectId, target.equipmentId);
  if (!openEvent) {
    stmtOpenEvent.run({
      projectId: target.projectId,
      equipmentId: target.equipmentId,
      label: target.label,
      fromState: "up",
      toState: "down",
      startedAt: new Date(startedMs).toISOString(),
    });
  }
}

function clearDownAndMaybeCloseEvent(target, wasDown) {
  const key = target.projectId + ":" + target.equipmentId;
  downSince.delete(key);
  if (!wasDown) return;
  const nowIso = new Date().toISOString();
  const openEvent = stmtFindOpenEvent.get(target.projectId, target.equipmentId);
  if (openEvent) {
    const durationSec = Math.max(0, Math.round((Date.now() - Date.parse(openEvent.started_at)) / 1000));
    stmtCloseEvent.run(nowIso, durationSec, openEvent.id);
  }
}

// failDurationMsOverride — для источников, у которых свой отдельный порог
// вместо sppd_fail_duration_sec (например, fieldsense-worker.js читает
// fs_fail_duration_sec и передаёт готовые мс сюда, а не полагается на
// getFailDurationMs ниже, которая жёстко привязана к колонке SPPD).
function applyOnlineState(target, online, metricsPatch, failDurationMsOverride) {
  const nowIso = new Date().toISOString();
  const nextState = online ? "up" : "down";
  const current = stmtGetStatus.get(target.projectId, target.equipmentId);

  // Статус — сразу, сырой: явный push от считывателя красит немедленно.
  // Метрики — мёрджим поверх уже накопленного, а не затираем: State-событие
  // само по себе редко несёт TxRx/VLine, они обычно из более ранних сообщений.
  stmtUpsertState.run({
    projectId: target.projectId,
    equipmentId: target.equipmentId,
    state: nextState,
    checkedAt: nowIso,
    changedAt: nowIso,
    metrics: metricsPatch
      ? mergeMetricsJson(current && current.raw_metrics_json, metricsPatch)
      : (current ? current.raw_metrics_json : null),
  });

  if (online) {
    clearDownAndMaybeCloseEvent(target, current && current.state === "down");
  } else {
    const failDurationMs = failDurationMsOverride != null ? failDurationMsOverride : getFailDurationMs(target.projectId);
    trackDownAndMaybeOpenEvent(target, failDurationMs);
  }
}

function applyCounts(target, personCount, vehicleCount) {
  stmtUpsertCounts.run({
    projectId: target.projectId,
    equipmentId: target.equipmentId,
    checkedAt: new Date().toISOString(),
    personCount: personCount ?? null,
    vehicleCount: vehicleCount ?? null,
  });
}

function emitTagPulse(target) {
  stmtInsertTagPulse.run(target.projectId, target.equipmentId);
}

function markStaleAsDown(target) {
  const nowIso = new Date().toISOString();
  // Статус — сразу, как и раньше: тишина дольше sppd_stale_after_sec это и
  // есть самый ранний момент, когда мы вообще можем узнать о пропаже (см.
  // checkStaleness) — здесь красим сразу, без дополнительной задержки.
  // raw_metrics_json/person_count/vehicle_count намеренно не трогаем
  // (stmtMarkStale, не stmtUpsertState) — "протухшая" метка означает "давно
  // нет вестей", а не "заново собранные нулевые данные".
  stmtMarkStale.run({
    projectId: target.projectId,
    equipmentId: target.equipmentId,
    checkedAt: nowIso,
    changedAt: nowIso,
  });
  trackDownAndMaybeOpenEvent(target, getFailDurationMs(target.projectId));
}

// Порог молчания — per-project (см. project_monitor_thresholds в db.js,
// настраивается админом через "⚙ Пороги" в UI). Отсутствие строки для
// проекта = STALE_AFTER_MS из env, как раньше.
const stmtGetStaleThreshold = db.prepare(
  "SELECT sppd_stale_after_sec, sppd_fail_duration_sec FROM project_monitor_thresholds WHERE project_id = ?"
);
function getStaleAfterMs(projectId) {
  const row = stmtGetStaleThreshold.get(projectId);
  return row ? row.sppd_stale_after_sec * 1000 : STALE_AFTER_MS;
}
function getFailDurationMs(projectId) {
  const row = stmtGetStaleThreshold.get(projectId);
  return row ? row.sppd_fail_duration_sec * 1000 : SPPD_FAIL_DURATION_MS;
}

// Раз в STALE_CHECK_MS проверяет все настроенные на этом сайте цели: если
// от Addr не было ни одного сообщения дольше порога — считаем это
// "Нет связи". siteStartedAtMs — точка отсчёта для оборудования, по
// которому вообще ещё не было ни одной записи в monitor_status (даёт
// новому/только настроенному считывателю запас времени с момента старта
// воркера, а не мгновенную красную вспышку до первого ответа).
function checkStaleness(projectId, targetsByAddr, siteStartedAtMs) {
  const nowMs = Date.now();
  const staleAfterMs = getStaleAfterMs(projectId);
  for (const targets of targetsByAddr.values()) {
    for (const target of targets) {
      const row = stmtGetLastChecked.get(target.projectId, target.equipmentId);
      const lastSeenMs = row && row.last_checked_at ? Date.parse(row.last_checked_at) : siteStartedAtMs;
      if (nowMs - lastSeenMs > staleAfterMs) {
        markStaleAsDown(target);
        if (DEBUG) {
          console.log(`[sppd-worker] [${projectId}] ${target.equipmentId} (${target.label}) — нет данных дольше ${staleAfterMs}мс, помечено как "Нет связи"`);
        }
      }
    }
  }
}

// Во всех трёх обработчиках лог печатается ПЕРЕД любым ранним return —
// раньше он стоял после проверки на data.Addr, и когда сообщение почему-то
// не проходило эту проверку, мы не видели вообще ничего (именно так и
// потерялись SB_EVENT для настроенных Addr на живой системе — раньше не
// могли понять, в чём дело, потому что сам факт отбраковки не логировался).
function handleSbEvent(msg, targetsByAddr, siteLabel) {
  const data = msg.WSM_DATA;
  if (DEBUG) {
    console.log(`[sppd-worker]${siteLabel ? " [" + siteLabel + "]" : ""} SB_EVENT WSM_DATA=${JSON.stringify(data)}`);
  }
  if (!data || !data.Addr) return;
  const targets = targetsByAddr.get(String(data.Addr));
  if (DEBUG) {
    console.log(`[sppd-worker]${siteLabel ? " [" + siteLabel + "]" : ""} SB_EVENT Addr=${data.Addr} OnLine=${data.State && data.State.OnLine} matched=${targets ? targets.length : 0}`);
  }
  if (!targets || !targets.length) return;

  // TxRx/Firmware/VLine (RSSI+напряжение) приходят каждый своим отдельным
  // SB_EVENT, без State рядом — State сам по себе редкое событие смены
  // online/offline, а не регулярный хартбит. Раньше метрики собирались
  // только если State тоже был в этом же сообщении, из-за чего почти все
  // TxRx/Firmware/VLine молча терялись.
  const metricsPatch = {};
  if (data.TxRx) metricsPatch.txRx = data.TxRx;
  if (data.Firmware) metricsPatch.firmware = data.Firmware;
  if (data.VLine && typeof data.VLine.VLine === "number") {
    metricsPatch.voltage = Math.round(data.VLine.VLine * 100) / 100;
    if (typeof data.VLine.RSSI === "number") metricsPatch.rssi = data.VLine.RSSI;
  }
  const hasMetrics = Object.keys(metricsPatch).length > 0;

  if (data.State && typeof data.State.OnLine === "boolean") {
    for (const target of targets) applyOnlineState(target, data.State.OnLine, hasMetrics ? metricsPatch : null);
  } else if (hasMetrics) {
    for (const target of targets) applyMetricsOnly(target, metricsPatch);
  }
}

function handleNofTag(msg, targetsByAddr, siteLabel) {
  const data = msg.WSM_DATA;
  if (DEBUG) {
    console.log(`[sppd-worker]${siteLabel ? " [" + siteLabel + "]" : ""} NOFTAG WSM_DATA=${JSON.stringify(data)}`);
  }
  if (!data || !data.Addr) return;
  const targets = targetsByAddr.get(String(data.Addr));
  if (DEBUG) {
    console.log(`[sppd-worker]${siteLabel ? " [" + siteLabel + "]" : ""} NOFTAG Addr=${data.Addr} NOfTag=${data.NOfTag} NOfMan=${data.NOfMan} NofVehicle=${data.NofVehicle} matched=${targets ? targets.length : 0}`);
  }
  if (!targets || !targets.length) return;
  for (const target of targets) applyCounts(target, data.NOfMan, data.NofVehicle);
}

// REG_TAG — дискретное событие "метка зарегистрировалась на считывателе"
// (обнаружено в реальном потоке SBeacon, изначально не документировано —
// раньше вспышку приближали по приросту счётчика NOfTag, теперь бьём точно
// по этому событию). Поле адреса тут в нижнем регистре — "addr", не "Addr"
// как в SB_EVENT/NOFTAG.
function handleRegTag(msg, targetsByAddr, siteLabel) {
  const data = msg.WSM_DATA;
  if (DEBUG) {
    console.log(`[sppd-worker]${siteLabel ? " [" + siteLabel + "]" : ""} REG_TAG WSM_DATA=${JSON.stringify(data)}`);
  }
  const addr = data && (data.addr ?? data.Addr);
  if (!data || addr === undefined || addr === null) return;
  const targets = targetsByAddr.get(String(addr));
  if (DEBUG) {
    console.log(`[sppd-worker]${siteLabel ? " [" + siteLabel + "]" : ""} REG_TAG addr=${addr} tag_id=${data.tag_id} matched=${targets ? targets.length : 0}`);
  }
  if (!targets || !targets.length) return;
  for (const target of targets) emitTagPulse(target);
}

/* ---------- один "сайт" — проект + свой SPPD-сервер ---------- */
// Origin/Referer — как у обычного браузера. Node-клиент 'ws' их не шлёт
// сам по себе, а Django-приложения нередко проверяют Origin на WebSocket-
// апгрейде так же, как Referer на обычных POST (см. csrfmiddlewaretoken в
// login()) — без этого сервер может принимать соединение, но молча не
// рассылать в него данные.
function connectStream(name, wsBase, path, sessionCookie, onMessage, getClosed) {
  let attempt = 0;
  let ws = null;
  const httpOrigin = wsBase.replace(/^ws/, "http");

  function scheduleReconnect() {
    if (getClosed()) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt++;
    setTimeout(open, delay);
  }

  function open() {
    if (getClosed()) return;
    ws = new WebSocket(`${wsBase}${path}`, {
      headers: { Cookie: sessionCookie, Origin: httpOrigin, Referer: `${httpOrigin}/` },
    });
    ws.on("open", () => {
      attempt = 0;
      console.log(`[sppd-worker] ${name} connected`);
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (DEBUG) console.log(`[sppd-worker] ${name} raw WSM_TYPE=${msg.WSM_TYPE}`);
        // WSM_DATA приходит с сервера как ВТОРОЙ раз закодированная JSON-
        // строка ("WSM_DATA":"{\"Addr\":...}"), а не готовый объект —
        // из-за этого data.Addr был всегда undefined, все сообщения
        // (включая совпадающие Addr) молча отбрасывались на первой же
        // проверке. srvUnixTime тут же — там WSM_DATA просто число в виде
        // строки ("1789469108"), JSON.parse превращает его в число, что
        // тоже нормально: этот тип сообщений мы всё равно не обрабатываем.
        if (typeof msg.WSM_DATA === "string") {
          try {
            msg.WSM_DATA = JSON.parse(msg.WSM_DATA);
          } catch (e) {
            // оставляем как есть — не JSON-строка, значит и не нужна нам
          }
        }
        onMessage(msg);
      } catch (err) {
        console.error(`[sppd-worker] ${name}: bad message:`, err.message);
      }
    });
    ws.on("close", () => {
      console.log(`[sppd-worker] ${name} disconnected`);
      scheduleReconnect();
    });
    ws.on("error", (err) => {
      console.error(`[sppd-worker] ${name} error:`, err.message);
    });
  }

  open();
  return {
    close() {
      if (ws) ws.close();
    },
  };
}

function logTargets(projectId, targetsByAddr) {
  const addrs = [...targetsByAddr.keys()];
  console.log(`[sppd-worker] [${projectId}] ${addrs.length} sppd-target Addr(s) configured: ${addrs.join(", ") || "(none)"}`);
}

function startSite(projectId, config) {
  const wsBase = config.baseUrl.replace(/^http/, "ws");
  const siteStartedAtMs = Date.now();
  let closed = false;
  let targetsByAddr = collectSppdTargets(projectId);
  logTargets(projectId, targetsByAddr);
  let telemetryConn = null;
  let beaconConn = null;
  let reloginTimer = null;
  let targetTimer = null;
  let staleTimer = null;

  targetTimer = setInterval(() => {
    if (closed) return;
    targetsByAddr = collectSppdTargets(projectId);
    if (DEBUG) logTargets(projectId, targetsByAddr);
  }, TARGET_REFRESH_MS);

  staleTimer = setInterval(() => {
    if (!closed) checkStaleness(projectId, targetsByAddr, siteStartedAtMs);
  }, STALE_CHECK_MS);

  async function connectAll() {
    if (closed) return;
    let sessionCookie;
    try {
      sessionCookie = await login(config);
      console.log(`[sppd-worker] [${projectId}] logged in to SPPD`);
    } catch (err) {
      console.error(`[sppd-worker] [${projectId}] login failed:`, err.message, "— retry in", RECONNECT_BASE_MS, "ms");
      if (!closed) setTimeout(connectAll, RECONNECT_BASE_MS);
      return;
    }
    if (telemetryConn) telemetryConn.close();
    if (beaconConn) beaconConn.close();
    // Разбираем по WSM_TYPE, а не по тому, с какого из двух соединений
    // пришло сообщение — на живой системе (проверено на apk) SB_EVENT и
    // REG_TAG/NOFTAG/srvUnixTime не строго привязаны к "своему" пути,
    // сообщения одного типа наблюдались на обоих сокетах. dispatch() не
    // ломается от лишних типов на любом канале — просто их игнорирует.
    function dispatch(msg) {
      // .trim() — на живой системе raw-лог печатал WSM_TYPE, визуально
      // совпадающий с "SB_EVENT"/"REG_TAG", но строгое сравнение почему-то
      // не срабатывало ни разу; похоже на непечатаемый символ (пробел,
      // BOM) в значении, который в консоли не виден.
      const type = typeof msg.WSM_TYPE === "string" ? msg.WSM_TYPE.trim() : msg.WSM_TYPE;
      if (DEBUG && type !== msg.WSM_TYPE) {
        console.log(`[sppd-worker] [${projectId}] WSM_TYPE mismatch after trim: raw=${JSON.stringify(msg.WSM_TYPE)} trimmed=${JSON.stringify(type)}`);
      }
      if (type === "SB_EVENT") handleSbEvent(msg, targetsByAddr, projectId);
      else if (type === "NOFTAG") handleNofTag(msg, targetsByAddr, projectId);
      else if (type === "REG_TAG") handleRegTag(msg, targetsByAddr, projectId);
      else if (DEBUG) {
        console.log(`[sppd-worker] [${projectId}] unhandled WSM_TYPE=${JSON.stringify(msg.WSM_TYPE)}`);
      }
    }
    telemetryConn = connectStream(`${projectId}/sppd`, wsBase, "/sppd/v1/ws/stream", sessionCookie, dispatch, () => closed);
    beaconConn = connectStream(`${projectId}/sbeacon`, wsBase, "/sbeacon/v1/ws/stream", sessionCookie, dispatch, () => closed);
  }

  connectAll();
  reloginTimer = setInterval(connectAll, SESSION_TTL_MS);

  return {
    config,
    stop() {
      closed = true;
      clearInterval(targetTimer);
      clearInterval(staleTimer);
      clearInterval(reloginTimer);
      if (telemetryConn) telemetryConn.close();
      if (beaconConn) beaconConn.close();
    },
  };
}

function sameConfig(a, b) {
  return a.baseUrl === b.baseUrl && a.username === b.username && a.password === b.password;
}

async function run() {
  const sites = new Map(); // projectId -> { config, stop() }

  function refresh() {
    const configs = loadSiteConfigs();
    for (const [projectId, site] of sites) {
      if (!configs.has(projectId) || !sameConfig(site.config, configs.get(projectId))) {
        console.log(`[sppd-worker] [${projectId}] config removed/changed — stopping site`);
        site.stop();
        sites.delete(projectId);
      }
    }
    for (const [projectId, config] of configs) {
      if (!sites.has(projectId)) {
        console.log(`[sppd-worker] [${projectId}] starting site (base=${config.baseUrl})`);
        sites.set(projectId, startSite(projectId, config));
      }
    }
    if (!configs.size) {
      console.log("[sppd-worker] no projects configured for SPPD (see .../monitor/sppd-config)");
    }
  }

  refresh();
  setInterval(refresh, CONFIG_REFRESH_MS);

  const cleanupInterval = setInterval(() => {
    stmtCleanupTagPulses.run(`-${Math.round(TAG_PULSE_MAX_AGE_MS / 1000)} seconds`);
  }, 60000);
  cleanupInterval.unref?.();
}

if (require.main === module) {
  console.log("[sppd-worker] starting — reading per-project config from project_sppd_config");
  run();
}

module.exports = {
  loadSiteConfigs,
  collectSppdTargets,
  applyOnlineState,
  applyMetricsOnly,
  applyCounts,
  emitTagPulse,
  handleSbEvent,
  handleNofTag,
  handleRegTag,
  markStaleAsDown,
  checkStaleness,
  login,
  parseSetCookiePairs,
  sameConfig,
  connectStream,
};
