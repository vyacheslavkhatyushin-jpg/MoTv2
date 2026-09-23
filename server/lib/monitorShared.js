/*
Низкоуровневая часть, общая для всех "живых" (push/poll) коллекторов
мониторинга — логин, WebSocket с реконнектом, запись в
monitor_status/monitor_events. Выделено из бывшего sppd-worker.js
(протокол SPPD/SBeacon и fieldsense-worker.js удалены — см. git-историю —
их объём полностью закрывается универсальным custom-monitor-worker.js,
см. server/routes/parsing.js), т.к. эти функции протокол-агностичны и
остаются единственным их потребителем.
*/
const { WebSocket } = require("ws");
const db = require("../db");

const RECONNECT_BASE_MS = parseInt(process.env.MONITOR_RECONNECT_BASE_MS || "3000", 10);
const RECONNECT_MAX_MS = parseInt(process.env.MONITOR_RECONNECT_MAX_MS || "30000", 10);
const DEBUG = process.env.MONITOR_SHARED_DEBUG === "1";

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
  // PHP-бэкенда на том же хосте.
  const merged = { ...cookies1, ...cookies2 };
  if (!merged.sessionid) {
    throw new Error(`Логин не удался (HTTP ${postResp.status}, sessionid отсутствует)`);
  }
  return Object.entries(merged)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/* ---------- какое оборудование СЕЙЧАС реально мониторится ----------
Единственный источник истины для критерия "мониторится" — раньше он был
продублирован (ping-worker.js/collectPingTargets, custom-monitor-worker.js/
collectCustomTargets), и чтение статуса (getMonitorStatus в server.js,
GET /:id/monitor/status в routes/projects.js) вообще не сверялось с этим
критерием, а просто отдавало ВСЁ, что накопилось в monitor_status —
включая "осиротевшие" строки оборудования, которое удалили, переименовали
(новый id) или у которого просто выключили мониторинг, но не удалили сам
объект. Такие строки никогда не подчищались автоматически (только вручную
через cleanup-orphaned-monitor-data.js) и молча подмешивались в сумму
🟢/🔴/⚪ на странице "Мониторинг" — расхождение с тем, что реально видно
в списке оборудования, вылезало у пользователя раз за разом при каждой
переконфигурации мониторинга, не только при удалении объекта.

Фикс — системный, не точечный: обе точки чтения статуса (WS-рассылка и
REST-фолбэк) теперь фильтруют monitor_status по ЭТОМУ предикату каждый
раз, а не доверяют содержимому таблицы — значит, даже если где-то в
будущем появится ещё один способ оставить осиротевшую строку, она
перестанет попадать в интерфейс сама по себе, без ручной чистки. */
function isEquipmentMonitored(eq) {
  if (eq.monitorMethod === "ping") return !!eq.ip;
  if (eq.monitorMethod === "custom") return !!eq.dataSourceId && !!eq.sourceAddress;
  return false;
}
function loadProjectEquipment(projectId) {
  const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  if (!row) return [];
  try {
    return JSON.parse(row.snapshot_json).equipment || [];
  } catch (e) {
    console.error(`[monitorShared] bad snapshot_json for project ${projectId}:`, e.message);
    return [];
  }
}
function getMonitoredEquipmentIds(projectId) {
  return new Set(loadProjectEquipment(projectId).filter(isEquipmentMonitored).map((eq) => eq.id));
}

/* ---------- запись состояния в monitor_status/monitor_events ---------- */
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
// state='up' на INSERT — если счётчик вообще дошёл и распарсился, источник
// точно жив (тот же довод, что и в applyMetricsOnly ниже); "unknown" как
// отдельный бакет статуса на дашборде больше не показывается.
const stmtUpsertCounts = db.prepare(`
  INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, person_count, vehicle_count)
  VALUES (@projectId, @equipmentId, 'up', @checkedAt, @personCount, @vehicleCount)
  ON CONFLICT(project_id, equipment_id) DO UPDATE SET
    last_checked_at = @checkedAt,
    person_count = @personCount,
    vehicle_count = @vehicleCount
`);
// Мёрдж патча метрик поверх уже сохранённых (а не перезапись) — иначе,
// например, одно сообщение стирало бы метрику, записанную предыдущим
// сообщением на тот же адрес, и наоборот.
function mergeMetricsJson(currentRawJson, patch) {
  const current = currentRawJson ? JSON.parse(currentRawJson) : {};
  return JSON.stringify(Object.assign({}, current, patch));
}
// Метрики без явного online-сигнала рядом (показания каналов у точечных
// источников вроде газоанализатора) — раз сообщение вообще дошло и
// распарсилось, источник точно жив, поэтому применяем как
// applyOnlineState(..., true, ...): выставляем "up" и закрываем открытый
// "down"-эвент, если он был (иначе оборудование без отдельного online-поля,
// один раз помеченное "down" по протуханию, никогда не вернулось бы в "up",
// хотя данные продолжают идти).
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

// Момент начала текущей непрерывной серии "down" на цель, в памяти процесса
// (сбрасывается при перезапуске воркера, не хранится в БД — внутренний
// таймер debounce для события monitor_events). Общий и для явного
// push online:false, и для обнаруженной тишины.
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

// failDurationMsOverride — обязателен: у каждого источника свой порог
// (custom_fail_duration_sec и т.п., настраивается через "Пороги"),
// единственный вызывающий (custom-monitor-worker.js) всегда передаёт его
// явно, единого протокол-специфичного порога тут больше нет.
function applyOnlineState(target, online, metricsPatch, failDurationMsOverride) {
  const nowIso = new Date().toISOString();
  const nextState = online ? "up" : "down";
  const current = stmtGetStatus.get(target.projectId, target.equipmentId);

  // Статус — сразу, сырой: явный push от источника красит немедленно.
  // Метрики — мёрджим поверх уже накопленного, а не затираем.
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
    trackDownAndMaybeOpenEvent(target, failDurationMsOverride);
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

/* ---------- один WS-поток с реконнектом ---------- */
// Origin/Referer — как у обычного браузера. Node-клиент 'ws' их не шлёт
// сам по себе, а Django-приложения нередко проверяют Origin на WebSocket-
// апгрейде так же, как Referer на обычных POST — без этого сервер может
// принимать соединение, но молча не рассылать в него данные.
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
      console.log(`[monitorShared] ${name} connected`);
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (DEBUG) console.log(`[monitorShared] ${name} raw WSM_TYPE=${msg.WSM_TYPE}`);
        // WSM_DATA иногда приходит как ВТОРОЙ раз закодированная JSON-строка
        // ("WSM_DATA":"{\"Addr\":...}"), а не готовый объект — разворачиваем.
        if (typeof msg.WSM_DATA === "string") {
          try {
            msg.WSM_DATA = JSON.parse(msg.WSM_DATA);
          } catch (e) {
            // оставляем как есть — не JSON-строка
          }
        }
        onMessage(msg);
      } catch (err) {
        console.error(`[monitorShared] ${name}: bad message:`, err.message);
      }
    });
    ws.on("close", () => {
      console.log(`[monitorShared] ${name} disconnected`);
      scheduleReconnect();
    });
    ws.on("error", (err) => {
      console.error(`[monitorShared] ${name} error:`, err.message);
    });
  }

  open();
  return {
    close() {
      if (ws) ws.close();
    },
  };
}

/* ---------- пер-формные переопределения порогов ---------- */
// См. project_shape_thresholds в db.js — необязательный override на
// (project_id, shape), с фоллбэком на дефолт проекта, если строки для
// формы нет или конкретная колонка в ней NULL.
const stmtGetShapeThresholds = db.prepare(
  "SELECT shape, stale_after_sec, fail_duration_sec FROM project_shape_thresholds WHERE project_id = ?"
);
function loadShapeThresholds(projectId) {
  const map = new Map();
  for (const row of stmtGetShapeThresholds.all(projectId)) {
    map.set(row.shape, { staleAfterSec: row.stale_after_sec, failDurationSec: row.fail_duration_sec });
  }
  return map;
}
function resolveFailDurationSec(shapeOverrides, shape, projectDefaultSec) {
  const o = shapeOverrides.get(shape);
  return o && o.failDurationSec != null ? o.failDurationSec : projectDefaultSec;
}
function resolveStaleAfterSec(shapeOverrides, shape, projectDefaultSec) {
  const o = shapeOverrides.get(shape);
  return o && o.staleAfterSec != null ? o.staleAfterSec : projectDefaultSec;
}

module.exports = {
  parseSetCookiePairs,
  login,
  connectStream,
  mergeMetricsJson,
  applyOnlineState,
  applyMetricsOnly,
  applyCounts,
  emitTagPulse,
  loadShapeThresholds,
  resolveFailDurationSec,
  resolveStaleAfterSec,
  isEquipmentMonitored,
  loadProjectEquipment,
  getMonitoredEquipmentIds,
};
