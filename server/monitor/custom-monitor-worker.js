/*
Универсальный коллектор мониторинга для настраиваемых источников данных
(project_data_sources, см. db.js и server/routes/parsing.js) — в отличие
от sppd-worker.js/fieldsense-worker.js (один захардкоженный протокол каждый),
этот воркер ничего не знает заранее о формате сообщений: вся логика разбора —
конфигурация в БД (parser_json), проверенная заранее интерактивно на
странице /parsing, см. server/lib/streamParserEngine.js.

Низкоуровневая часть (логин, WebSocket с реконнектом, запись в
monitor_status/monitor_events через applyOnlineState/applyMetricsOnly)
переиспользуется из sppd-worker.js как есть — она уже общая, тем же
способом её уже переиспользует fieldsense-worker.js. Своя (не переиспользуемая)
часть — только staleness по отдельным custom_stale_after_sec/
custom_fail_duration_sec порогам, т.к. семантически это не то же самое,
что sppd_stale_after_sec/sppd_fail_duration_sec.

Оборудование привязывается к источнику через equipment.monitorMethod === "custom",
equipment.dataSourceId (id из project_data_sources) и equipment.sourceAddress —
адрес в терминах ЭТОГО конкретного источника (то, что resolvePath/каталог+
профиль извлекают из сообщения), а не общий sppdAddress/fsAddress.
*/
const db = require("../db");
const sppd = require("./sppd-worker");
const engine = require("../lib/streamParserEngine");

const CONFIG_REFRESH_MS = parseInt(process.env.CUSTOM_CONFIG_REFRESH_MS || "60000", 10);
const TARGET_REFRESH_MS = parseInt(process.env.CUSTOM_TARGET_REFRESH_MS || "30000", 10);
const STALE_CHECK_MS = parseInt(process.env.CUSTOM_STALE_CHECK_MS || "30000", 10);
const RECONNECT_BASE_MS = parseInt(process.env.CUSTOM_RECONNECT_BASE_MS || "3000", 10);
const DEBUG = process.env.CUSTOM_MONITOR_DEBUG === "1";

const stmtGetThresholds = db.prepare(
  "SELECT custom_stale_after_sec, custom_fail_duration_sec FROM project_monitor_thresholds WHERE project_id = ?"
);
function getStaleAfterMs(projectId) {
  const row = stmtGetThresholds.get(projectId);
  return (row ? row.custom_stale_after_sec : 120) * 1000;
}
function getFailDurationMs(projectId) {
  const row = stmtGetThresholds.get(projectId);
  return (row ? row.custom_fail_duration_sec : 300) * 1000;
}

const stmtGetLastChecked = db.prepare(
  "SELECT last_checked_at FROM monitor_status WHERE project_id = ? AND equipment_id = ?"
);
const stmtMarkStale = db.prepare(`
  INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, last_change_at)
  VALUES (@projectId, @equipmentId, 'down', @checkedAt, @changedAt)
  ON CONFLICT(project_id, equipment_id) DO UPDATE SET
    state = 'down',
    last_checked_at = @checkedAt,
    last_change_at = CASE WHEN monitor_status.state != 'down' THEN @changedAt ELSE monitor_status.last_change_at END
`);

/* ---------- конфигурация источников ---------- */
function loadSourceConfigs() {
  const rows = db.prepare("SELECT * FROM project_data_sources WHERE enabled = 1").all();
  return rows.map((row) => {
    let connection, parser;
    try {
      connection = JSON.parse(row.connection_json);
      parser = JSON.parse(row.parser_json);
    } catch (err) {
      console.error(`[custom-monitor-worker] bad JSON config for source ${row.id}:`, err.message);
      return null;
    }
    return { id: row.id, projectId: row.project_id, name: row.name, connection, parser };
  }).filter(Boolean);
}

function sameSourceConfig(a, b) {
  return (
    JSON.stringify(a.connection) === JSON.stringify(b.connection) &&
    JSON.stringify(a.parser) === JSON.stringify(b.parser)
  );
}

/* ---------- цели: оборудование, привязанное к этому источнику ---------- */
function collectCustomTargets(projectId, sourceId) {
  const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  const byAddr = new Map();
  if (!row) return byAddr;
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch (err) {
    console.error(`[custom-monitor-worker] bad snapshot_json for project ${projectId}:`, err.message);
    return byAddr;
  }
  for (const eq of snapshot.equipment || []) {
    if (eq.monitorMethod !== "custom" || eq.dataSourceId !== sourceId || !eq.sourceAddress) continue;
    const addr = String(eq.sourceAddress);
    if (!byAddr.has(addr)) byAddr.set(addr, []);
    byAddr.get(addr).push({ projectId, equipmentId: eq.id, label: eq.label });
  }
  return byAddr;
}

function markStaleAsDown(target) {
  const nowIso = new Date().toISOString();
  stmtMarkStale.run({ projectId: target.projectId, equipmentId: target.equipmentId, checkedAt: nowIso, changedAt: nowIso });
}

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
          console.log(`[custom-monitor-worker] [${projectId}] ${target.equipmentId} (${target.label}) — нет данных дольше ${staleAfterMs}мс`);
        }
      }
    }
  }
}

/* ---------- применение результата разбора к целям ---------- */
function applyParsedResult(projectId, targetsByAddr, parsed) {
  const targets = targetsByAddr.get(String(parsed.address));
  if (!targets || !targets.length) return;

  const onlineAttr = parsed.attributes.find((a) => a.key === "online");
  // tagPulseEvent — не метрика, а разовое событие ("метка зарегистрирована"):
  // в проде это INSERT в monitor_tag_pulses (см. sppd-worker.emitTagPulse),
  // который server.js рассылает по WS для вспышки в 3D-редакторе
  // (spawnMonitorTagPulse). Значение атрибута тут неважно, важен сам факт —
  // поэтому не кладём его в raw_metrics_json как обычную метрику.
  const hasTagPulse = parsed.attributes.some((a) => a.key === "tagPulseEvent");
  const metricsPatch = {};
  for (const a of parsed.attributes) {
    if (a.key === "online" || a.key === "tagPulseEvent") continue;
    metricsPatch[a.key] = a.value;
  }
  const hasMetrics = Object.keys(metricsPatch).length > 0;

  for (const target of targets) {
    if (onlineAttr) {
      sppd.applyOnlineState(target, Boolean(onlineAttr.value), hasMetrics ? metricsPatch : null, getFailDurationMs(projectId));
    } else if (hasMetrics) {
      sppd.applyMetricsOnly(target, metricsPatch);
    }
    if (hasTagPulse) sppd.emitTagPulse(target);
  }
}

/* ---------- один "сайт" — один настроенный источник ---------- */
function startSite(source) {
  const { connection, parser, projectId, id: sourceId } = source;
  const wsBase = connection.baseUrl.replace(/^http/, "ws");
  const siteStartedAtMs = Date.now();
  let closed = false;
  let targetsByAddr = collectCustomTargets(projectId, sourceId);
  let conns = [];
  let reloginTimer = null;
  let targetTimer = null;
  let staleTimer = null;

  targetTimer = setInterval(() => {
    if (closed) return;
    targetsByAddr = collectCustomTargets(projectId, sourceId);
  }, TARGET_REFRESH_MS);

  staleTimer = setInterval(() => {
    if (!closed) checkStaleness(projectId, targetsByAddr, siteStartedAtMs);
  }, STALE_CHECK_MS);

  async function connectAll() {
    if (closed) return;
    let sessionCookie = "";
    if (connection.authType === "django-session-form") {
      try {
        sessionCookie = await sppd.login(connection);
        console.log(`[custom-monitor-worker] [${projectId}/${source.name}] logged in`);
      } catch (err) {
        console.error(`[custom-monitor-worker] [${projectId}/${source.name}] login failed:`, err.message, "— retry in", RECONNECT_BASE_MS, "ms");
        if (!closed) setTimeout(connectAll, RECONNECT_BASE_MS);
        return;
      }
    }
    conns.forEach((c) => c.close());
    // sppd.connectStream разбирает JSON и (если есть) разворачивает
    // WSM_DATA-как-строку ДО вызова onMessage — отдаёт уже объект, не
    // сырую строку. engine.parseMessage ожидает строку (сам делает
    // JSON.parse внутри), поэтому здесь просто сериализуем обратно —
    // для сообщений без WSM_TYPE/WSM_DATA (режим "bypoint") это no-op,
    // для остальных — эквивалентный, уже частично разобранный JSON.
    conns = (connection.endpoints || [])
      .filter((ep) => ep && ep.path)
      .map((ep) =>
        sppd.connectStream(`${projectId}/${source.name}/${ep.name || ep.path}`, wsBase, ep.path, sessionCookie, (msg) => {
          try {
            const results = engine.parseMessage(JSON.stringify(msg), parser);
            for (const result of results) applyParsedResult(projectId, targetsByAddr, result);
          } catch (err) {
            if (DEBUG) console.error(`[custom-monitor-worker] [${projectId}/${source.name}] parse error:`, err.message);
          }
        }, () => closed)
      );
  }

  connectAll();
  reloginTimer = setInterval(connectAll, parseInt(process.env.CUSTOM_SESSION_TTL_MS || String(6 * 3600 * 1000), 10));

  return {
    source,
    stop() {
      closed = true;
      clearInterval(targetTimer);
      clearInterval(staleTimer);
      clearInterval(reloginTimer);
      conns.forEach((c) => c.close());
    },
  };
}

async function run() {
  const sites = new Map(); // sourceId -> { source, stop() }

  function refresh() {
    const configs = loadSourceConfigs();
    const byId = new Map(configs.map((c) => [c.id, c]));
    for (const [sourceId, site] of sites) {
      if (!byId.has(sourceId) || !sameSourceConfig(site.source, byId.get(sourceId))) {
        console.log(`[custom-monitor-worker] [${sourceId}] config removed/changed — stopping site`);
        site.stop();
        sites.delete(sourceId);
      }
    }
    for (const config of configs) {
      if (!sites.has(config.id)) {
        console.log(`[custom-monitor-worker] [${config.projectId}] starting source "${config.name}"`);
        sites.set(config.id, startSite(config));
      }
    }
    if (!configs.length) {
      console.log("[custom-monitor-worker] no enabled project_data_sources configured");
    }
  }

  refresh();
  setInterval(refresh, CONFIG_REFRESH_MS);
}

if (require.main === module) {
  console.log("[custom-monitor-worker] starting — reading project_data_sources");
  run();
}

module.exports = { loadSourceConfigs, collectCustomTargets, applyParsedResult, checkStaleness, sameSourceConfig };
