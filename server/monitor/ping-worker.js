/*
Ping-коллектор мониторинга (Этап 2, см. docs/monitoring-plan.md).

Отдельный процесс — деплоится своим сервисом в docker-compose, рядом с
основным server.js, но не его частью: сетевые таймауты и нестабильность
опроса не должны влиять на редактор модели. Работает с той же SQLite-базой
через общий volume (см. server/db.js — путь берётся из DB_PATH так же, как
у основного сервера).

Раз в PING_INTERVAL_MS проходит по всем проектам, собирает оборудование с
monitorMethod:"ping" и непустым IP, пингует параллельно (с ограничением
конкурентности — при ~200 устройствах открывать 200 процессов ping разом
не нужно), и пишет результат в monitor_status/monitor_events.
*/
const { execFile } = require("child_process");
const db = require("../db");
const { loadShapeThresholds, resolveFailDurationSec } = require("../lib/monitorShared");

const INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || "60000", 10);
const CONCURRENCY = parseInt(process.env.PING_CONCURRENCY || "20", 10);
const PING_TIMEOUT_SEC = parseInt(process.env.PING_TIMEOUT_SEC || "1", 10);
const PING_FAIL_DURATION_SEC = parseInt(process.env.PING_FAIL_DURATION_SEC || "300", 10);

// Пороги — per-project (см. project_monitor_thresholds в db.js, настраивается
// админом в модуле "Настройки" → Пороги). Отсутствие строки для проекта =
// дефолты из env выше, поэтому существующие проекты без явной настройки
// ведут себя как раньше. failDurationSec дополнительно может быть
// переопределён per-shape (project_shape_thresholds, см. collectPingTargets).
const stmtGetThresholds = db.prepare(
  "SELECT ping_timeout_sec, ping_fail_duration_sec FROM project_monitor_thresholds WHERE project_id = ?"
);
function loadProjectThresholds(projectId) {
  const row = stmtGetThresholds.get(projectId);
  return {
    pingTimeoutSec: row ? row.ping_timeout_sec : PING_TIMEOUT_SEC,
    failDurationSec: row ? row.ping_fail_duration_sec : PING_FAIL_DURATION_SEC,
  };
}

function pingHost(ip, timeoutSec) {
  return new Promise((resolve) => {
    execFile("ping", ["-c", "1", "-W", String(timeoutSec || PING_TIMEOUT_SEC), ip], (err, stdout) => {
      if (err) return resolve({ up: false, latencyMs: null });
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
      resolve({ up: true, latencyMs: m ? parseFloat(m[1]) : null });
    });
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function collectPingTargets() {
  const projects = db.prepare("SELECT id FROM projects").all();
  const targets = [];
  for (const { id: projectId } of projects) {
    const row = db
      .prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?")
      .get(projectId);
    if (!row) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch (err) {
      console.error(`[ping-worker] bad snapshot_json for project ${projectId}:`, err.message);
      continue;
    }
    const thresholds = loadProjectThresholds(projectId);
    const shapeOverrides = loadShapeThresholds(projectId);
    for (const eq of snapshot.equipment || []) {
      if (eq.monitorMethod === "ping" && eq.ip) {
        targets.push({
          projectId, equipmentId: eq.id, label: eq.label, ip: eq.ip,
          pingTimeoutSec: thresholds.pingTimeoutSec,
          failDurationSec: resolveFailDurationSec(shapeOverrides, eq.shape, thresholds.failDurationSec),
        });
      }
    }
  }
  return targets;
}

const stmtGetStatus = db.prepare(
  "SELECT state FROM monitor_status WHERE project_id = ? AND equipment_id = ?"
);
const stmtUpsertStatus = db.prepare(`
  INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, last_change_at, latency_ms)
  VALUES (@projectId, @equipmentId, @state, @checkedAt, @changedAt, @latencyMs)
  ON CONFLICT(project_id, equipment_id) DO UPDATE SET
    state = @state,
    last_checked_at = @checkedAt,
    last_change_at = CASE WHEN monitor_status.state != @state THEN @changedAt ELSE monitor_status.last_change_at END,
    latency_ms = @latencyMs
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
const stmtCloseEvent = db.prepare(
  "UPDATE monitor_events SET ended_at = ?, duration_sec = ? WHERE id = ?"
);

// Момент начала текущей непрерывной серии неудачных пингов на цель, в
// памяти процесса (сбрасывается при перезапуске воркера — не страшно,
// худший случай: серия после рестарта считается начавшейся заново, "авария"
// зафиксируется на failDurationSec позже реального начала простоя). Не
// хранится в БД — это внутренний таймер debounce для события, не нужный
// никому кроме тика, который его и завёл.
const downSince = new Map(); // `${projectId}:${equipmentId}` -> ms timestamp

function applyResult(target, result) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const key = target.projectId + ":" + target.equipmentId;
  const current = stmtGetStatus.get(target.projectId, target.equipmentId);
  const rawState = result.up ? "up" : "down";

  // Статус на дашборде/3D-модели — всегда сырой результат последнего пинга,
  // без debounce: "нет пинга" красит красным немедленно, вне зависимости от
  // того, сколько длится простой и настроен ли порог для аварии.
  stmtUpsertStatus.run({
    projectId: target.projectId, equipmentId: target.equipmentId, state: rawState,
    checkedAt: nowIso, changedAt: nowIso, latencyMs: result.latencyMs,
  });

  if (result.up) {
    downSince.delete(key);
    if (current && current.state === "down") {
      // Возврат в строй — если авария успела зафиксироваться как событие
      // (простой набрал failDurationSec), закрываем его. Если не успела
      // (флап короче порога) — открытого события и не было, закрывать нечего.
      const openEvent = stmtFindOpenEvent.get(target.projectId, target.equipmentId);
      if (openEvent) {
        const durationSec = Math.max(0, Math.round((nowMs - Date.parse(openEvent.started_at)) / 1000));
        stmtCloseEvent.run(nowIso, durationSec, openEvent.id);
      }
    }
    return;
  }

  // Неудачный пинг — отслеживаем длительность непрерывного простоя и
  // фиксируем "аварию" как событие только после failDurationSec (per-project,
  // по умолчанию 300 с). До этого момента событие не пишется — одиночный
  // потерянный пакет или короткий флап не попадает в историю аварий/аптайм.
  if (!downSince.has(key)) downSince.set(key, nowMs);
  const startedMs = downSince.get(key);
  const durationSec = target.failDurationSec ?? PING_FAIL_DURATION_SEC;
  if (nowMs - startedMs < durationSec * 1000) return;

  const openEvent = stmtFindOpenEvent.get(target.projectId, target.equipmentId);
  if (!openEvent) {
    stmtOpenEvent.run({
      projectId: target.projectId, equipmentId: target.equipmentId, label: target.label,
      fromState: "up", toState: "down", startedAt: new Date(startedMs).toISOString(),
    });
  }
}

const applyResultsTx = db.transaction((targets, results) => {
  targets.forEach((target, i) => applyResult(target, results[i]));
});

async function tick() {
  const targets = collectPingTargets();
  if (!targets.length) {
    console.log("[ping-worker] no ping-monitored equipment found");
    return;
  }
  const results = await runWithConcurrency(targets, CONCURRENCY, (t) => pingHost(t.ip, t.pingTimeoutSec));
  applyResultsTx(targets, results);
  const upCount = results.filter((r) => r.up).length;
  console.log(`[ping-worker] checked ${targets.length} host(s), ${upCount} up, ${targets.length - upCount} down`);
}

async function loop() {
  for (;;) {
    const start = Date.now();
    try {
      await tick();
    } catch (err) {
      console.error("[ping-worker] tick failed:", err);
    }
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, Math.max(1000, INTERVAL_MS - elapsed)));
  }
}

if (require.main === module) {
  console.log(`[ping-worker] starting — interval=${INTERVAL_MS}ms concurrency=${CONCURRENCY} timeout=${PING_TIMEOUT_SEC}s`);
  loop();
}

module.exports = { collectPingTargets, applyResult, tick, pingHost };
