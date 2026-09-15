/*
SPPD/SBeacon-коллектор мониторинга (Этап 4, см. docs/monitoring-plan.md).

Отдельный процесс, как ping-worker.js — свой сервис в docker-compose, та же
SQLite через общий volume. В отличие от ping-worker (опрос по таймеру), этот
воркер держит два постоянных WebSocket-соединения к системе SPPD (реальное
название системы, которую изначально называли "FlexCom") на шахте и
обрабатывает события по мере поступления:

  - ws://<SPPD_BASE_HOST>/sppd/v1/ws/stream    — телеметрия устройств
    (SB_EVENT: Addr, State.OnLine, TxRx, Firmware) → online/offline для
    оборудования с monitorMethod:"sppd" (в модели это IILB/ISIB).
  - ws://<SPPD_BASE_HOST>/sbeacon/v1/ws/stream — счётчик меток/людей на
    считывателе (NOFTAG: Addr, NOfTag, NOfMan, NofVehicle) →
    person_count/vehicle_count того же оборудования, плюс разовая
    "вспышка" (monitor_tag_pulses) при росте счётчика меток — приближённая
    замена по-меточным событиям, которых в потоке нет, см. docs.

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

const BASE_URL = (process.env.SPPD_BASE_URL || "http://10.20.99.7").replace(/\/+$/, "");
const WS_BASE = BASE_URL.replace(/^http/, "ws");
const USERNAME = process.env.SPPD_USERNAME || "";
const PASSWORD = process.env.SPPD_PASSWORD || "";
const TARGET_REFRESH_MS = parseInt(process.env.SPPD_TARGET_REFRESH_MS || "30000", 10);
const SESSION_TTL_MS = parseInt(process.env.SPPD_SESSION_TTL_MS || String(6 * 3600 * 1000), 10);
const RECONNECT_BASE_MS = parseInt(process.env.SPPD_RECONNECT_BASE_MS || "3000", 10);
const RECONNECT_MAX_MS = parseInt(process.env.SPPD_RECONNECT_MAX_MS || "30000", 10);
const TAG_PULSE_MAX_AGE_MS = parseInt(process.env.SPPD_TAG_PULSE_MAX_AGE_MS || String(2 * 60 * 1000), 10);

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

async function login() {
  if (!USERNAME || !PASSWORD) {
    throw new Error("SPPD_USERNAME/SPPD_PASSWORD не заданы");
  }
  const loginPageResp = await fetch(`${BASE_URL}/login/`, { redirect: "manual" });
  const loginPageHtml = await loginPageResp.text();
  const cookies1 = parseSetCookiePairs(loginPageResp.headers);
  const csrftoken = cookies1.csrftoken;
  const m = /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/.exec(loginPageHtml);
  const csrfmiddlewaretoken = m ? m[1] : null;
  if (!csrftoken || !csrfmiddlewaretoken) {
    throw new Error("Не удалось получить csrftoken/csrfmiddlewaretoken со страницы логина");
  }

  const body = new URLSearchParams({
    username: USERNAME,
    password: PASSWORD,
    csrfmiddlewaretoken,
    next: "/",
    login: "",
  });
  const postResp = await fetch(`${BASE_URL}/login/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `csrftoken=${csrftoken}`,
      Referer: `${BASE_URL}/login/`,
    },
    body: body.toString(),
  });
  const cookies2 = parseSetCookiePairs(postResp.headers);
  const sessionid = cookies2.sessionid;
  if (!sessionid) {
    throw new Error(`Логин SPPD не удался (HTTP ${postResp.status}, sessionid отсутствует)`);
  }
  return `csrftoken=${cookies2.csrftoken || csrftoken}; sessionid=${sessionid}`;
}

/* ---------- сбор целей: оборудование с monitorMethod:"sppd" ----------
   Addr -> [{projectId, equipmentId, label}] — один физический Addr в
   редких случаях может стоять в нескольких проектах, поэтому массив. */
function collectSppdTargets() {
  const projects = db.prepare("SELECT id FROM projects").all();
  const byAddr = new Map();
  for (const { id: projectId } of projects) {
    const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
    if (!row) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch (err) {
      console.error(`[sppd-worker] bad snapshot_json for project ${projectId}:`, err.message);
      continue;
    }
    for (const eq of snapshot.equipment || []) {
      if (eq.monitorMethod !== "sppd" || !eq.sppdAddress) continue;
      const addr = String(eq.sppdAddress);
      if (!byAddr.has(addr)) byAddr.set(addr, []);
      byAddr.get(addr).push({ projectId, equipmentId: eq.id, label: eq.label });
    }
  }
  return byAddr;
}

/* ---------- запись состояния в monitor_status/monitor_events ---------- */
const stmtGetStatus = db.prepare("SELECT state FROM monitor_status WHERE project_id = ? AND equipment_id = ?");
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
const stmtInsertTagPulse = db.prepare(
  "INSERT INTO monitor_tag_pulses (project_id, equipment_id) VALUES (?, ?)"
);
const stmtCleanupTagPulses = db.prepare(
  "DELETE FROM monitor_tag_pulses WHERE created_at < datetime('now', ?)"
);

function applyOnlineState(target, online, metrics) {
  const nowIso = new Date().toISOString();
  const nextState = online ? "up" : "down";
  const current = stmtGetStatus.get(target.projectId, target.equipmentId);
  const changed = !current || current.state !== nextState;

  stmtUpsertState.run({
    projectId: target.projectId,
    equipmentId: target.equipmentId,
    state: nextState,
    checkedAt: nowIso,
    changedAt: nowIso,
    metrics: metrics ? JSON.stringify(metrics) : null,
  });

  if (!changed) return;

  if (nextState === "down") {
    stmtOpenEvent.run({
      projectId: target.projectId,
      equipmentId: target.equipmentId,
      label: target.label,
      fromState: current ? current.state : null,
      toState: nextState,
      startedAt: nowIso,
    });
  } else if (current) {
    const openEvent = stmtFindOpenEvent.get(target.projectId, target.equipmentId);
    if (openEvent) {
      const durationSec = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(openEvent.started_at)) / 1000));
      stmtCloseEvent.run(nowIso, durationSec, openEvent.id);
    }
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

/* ---------- WS-подключения ---------- */
// В памяти между сообщениями: последнее увиденное NOfTag на Addr, чтобы
// вспышку "новая метка" слать только на рост счётчика, а не на каждое
// сообщение потока (счётчик передаётся целиком, не дельтой).
const lastTagCountByAddr = new Map();

function connectStream(name, path, sessionCookie, onMessage) {
  let closedByUs = false;
  let attempt = 0;
  let ws = null;

  function scheduleReconnect() {
    if (closedByUs) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt++;
    setTimeout(open, delay);
  }

  function open() {
    ws = new WebSocket(`${WS_BASE}${path}`, { headers: { Cookie: sessionCookie } });
    ws.on("open", () => {
      attempt = 0;
      console.log(`[sppd-worker] ${name} connected`);
    });
    ws.on("message", (data) => {
      try {
        onMessage(JSON.parse(data.toString()));
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
      closedByUs = true;
      if (ws) ws.close();
    },
  };
}

function handleSbEvent(msg, targetsByAddr) {
  const data = msg.WSM_DATA;
  if (!data || !data.Addr) return;
  const targets = targetsByAddr.get(String(data.Addr));
  if (!targets || !targets.length) return;
  if (data.State && typeof data.State.OnLine === "boolean") {
    const metrics = {};
    if (data.TxRx) metrics.txRx = data.TxRx;
    if (data.Firmware) metrics.firmware = data.Firmware;
    for (const target of targets) applyOnlineState(target, data.State.OnLine, Object.keys(metrics).length ? metrics : null);
  }
}

function handleNofTag(msg, targetsByAddr) {
  const data = msg.WSM_DATA;
  if (!data || !data.Addr) return;
  const targets = targetsByAddr.get(String(data.Addr));
  if (!targets || !targets.length) return;
  for (const target of targets) applyCounts(target, data.NOfMan, data.NofVehicle);

  const prevCount = lastTagCountByAddr.get(data.Addr);
  const nextCount = typeof data.NOfTag === "number" ? data.NOfTag : null;
  if (nextCount !== null) {
    if (typeof prevCount === "number" && nextCount > prevCount) {
      for (const target of targets) emitTagPulse(target);
    }
    lastTagCountByAddr.set(data.Addr, nextCount);
  }
}

async function run() {
  if (!USERNAME || !PASSWORD) {
    console.error("[sppd-worker] SPPD_USERNAME/SPPD_PASSWORD не заданы — воркер не запущен.");
    return;
  }

  let targetsByAddr = collectSppdTargets();
  const refreshTargets = () => {
    targetsByAddr = collectSppdTargets();
  };
  setInterval(refreshTargets, TARGET_REFRESH_MS);

  const cleanupInterval = setInterval(() => {
    stmtCleanupTagPulses.run(`-${Math.round(TAG_PULSE_MAX_AGE_MS / 1000)} seconds`);
  }, 60000);
  cleanupInterval.unref?.();

  let sessionCookie;
  let telemetryConn;
  let beaconConn;

  async function reconnectAll() {
    try {
      sessionCookie = await login();
      console.log("[sppd-worker] logged in to SPPD");
    } catch (err) {
      console.error("[sppd-worker] login failed:", err.message, "— retry in", RECONNECT_BASE_MS, "ms");
      setTimeout(reconnectAll, RECONNECT_BASE_MS);
      return;
    }
    if (telemetryConn) telemetryConn.close();
    if (beaconConn) beaconConn.close();
    telemetryConn = connectStream("sppd", "/sppd/v1/ws/stream", sessionCookie, (msg) => {
      if (msg.WSM_TYPE === "SB_EVENT") handleSbEvent(msg, targetsByAddr);
    });
    beaconConn = connectStream("sbeacon", "/sbeacon/v1/ws/stream", sessionCookie, (msg) => {
      if (msg.WSM_TYPE === "NOFTAG") handleNofTag(msg, targetsByAddr);
    });
  }

  await reconnectAll();
  setInterval(reconnectAll, SESSION_TTL_MS);
}

if (require.main === module) {
  console.log(`[sppd-worker] starting — base=${BASE_URL}`);
  run();
}

module.exports = {
  collectSppdTargets,
  applyOnlineState,
  applyCounts,
  emitTagPulse,
  handleSbEvent,
  handleNofTag,
  login,
  parseSetCookiePairs,
};
