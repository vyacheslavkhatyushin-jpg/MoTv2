const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const { getMonitoredEquipmentIds, attachOpenEventAck } = require("../lib/monitorShared");

const router = express.Router();
const SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;

router.use(requireAuth);

// Project ids are always lowercase (enforced by SLUG_RE on creation); normalize
// the URL param too so /APK, /Apk and /apk all resolve to the same project
// instead of 404ing on a case mismatch.
router.param("id", (req, res, next, id) => {
  req.params.id = id.toLowerCase();
  next();
});

router.get("/", (req, res) => {
  const projects = db
    .prepare("SELECT id, name, created_at FROM projects ORDER BY name")
    .all();
  res.json({ projects });
});

// Список источников данных проекта для выпадающего списка на карточке
// оборудования (monitorMethod:"custom") — только id/name, без connection_json
// (там логин/пароль от промышленной системы шахты) и без parser_json.
// Полный CRUD с этими деталями — /api/parsing/sources, только admin/supervisor.
router.get("/:id/data-sources", (req, res) => {
  const sources = db
    .prepare("SELECT id, name FROM project_data_sources WHERE project_id = ? AND enabled = 1 ORDER BY name")
    .all(req.params.id);
  res.json({ sources });
});

router.post("/", requireRole("admin", "supervisor"), (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !SLUG_RE.test(id)) {
    return res.status(400).json({
      error: "invalid_id",
      message:
        "id must be 2-64 chars: lowercase letters, digits, - or _ (this becomes the URL path /:id)",
    });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "missing_name" });
  }
  const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id);
  if (exists) return res.status(409).json({ error: "already_exists" });
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(
    id,
    name.trim()
  );
  logAudit({ actor: req.user.username, projectId: id, action: "project.create", entityType: "project", entityId: id, entityLabel: name.trim(), ip: req.ip });
  res.status(201).json({ id, name: name.trim() });
});

router.get("/:id/state", (req, res) => {
  const project = db
    .prepare("SELECT id, name FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const state = db
    .prepare("SELECT snapshot_json, version, updated_by, updated_at FROM project_state WHERE project_id = ?")
    .get(req.params.id);

  if (!state) {
    return res.json({
      project,
      snapshot: null,
      version: 0,
      updatedBy: null,
      updatedAt: null,
    });
  }
  res.json({
    project,
    snapshot: JSON.parse(state.snapshot_json),
    version: state.version,
    updatedBy: state.updated_by,
    updatedAt: state.updated_at,
  });
});

// Трёхстороннее слияние одной коллекции объектов (кабели/оборудование/метки/
// заплатки) по id: incoming.upserts/deletes каждый несут "base" — версию
// объекта, какой её видел клиент перед правкой (null для новых объектов).
// Если текущая (серверная) версия объекта совпадает с этой базой — значит,
// с момента, когда клиент начал править, объект никто больше не трогал, и
// правку можно применить. Если не совпадает — кто-то другой успел изменить
// (или удалить) этот же объект первым: сохраняем ЕГО версию, а правку
// клиента отклоняем и сообщаем об этом отдельно по каждому такому объекту.
// Все остальные объекты в той же коллекции (не задетые конфликтом) сливаются
// нормально — в отличие от прежней схемы, где конфликт по одному объекту
// проваливал сохранение всего проекта целиком.
// Сводка объекта для журнала действий — без геометрии (список узлов
// кабеля/заплатки может быть большим и малополезен для "что изменилось").
function summarizeObjectForAudit(obj) {
  if (!obj) return null;
  const { nodes, ...meta } = obj;
  if (Array.isArray(nodes)) meta.nodeCount = nodes.length;
  return meta;
}

function mergeCollection(baseArr, incoming, context) {
  const byId = new Map((baseArr || []).map((o) => [o.id, o]));
  const conflicts = [];
  const applied = [];
  const deletedIds = [];
  for (const entry of (incoming && incoming.upserts) || []) {
    const { id, data, base } = entry || {};
    if (!id || !data) {
      // Не должно происходить — клиент всегда проставляет id перед
      // сериализацией, а раньше здесь тихо пропускалось без следа. Раз уже
      // столкнулись с "фантомными" объектами без id в БД (причина не
      // установлена), логируем сам факт — если повторится, будет видно
      // когда/кем/в какой коллекции.
      console.error(
        `[mergeCollection] пропущен upsert без id/data (${context}): ` +
        JSON.stringify({ id, hasData: !!data, label: data && data.label })
      );
      continue;
    }
    const currentObj = byId.get(id) || null;
    const currentJson = currentObj ? JSON.stringify(currentObj) : null;
    const baseJson = base ? JSON.stringify(base) : null;
    if (currentJson === baseJson) {
      byId.set(id, Object.assign({}, data, { id }));
      applied.push({
        id, kind: currentObj ? "update" : "create", label: data.label || id,
        before: summarizeObjectForAudit(currentObj), after: summarizeObjectForAudit(data),
      });
    } else {
      conflicts.push({
        id,
        label: (data && data.label) || (currentObj && currentObj.label) || id,
        action: "upsert",
      });
    }
  }
  for (const entry of (incoming && incoming.deletes) || []) {
    const { id, base } = entry || {};
    if (!id) {
      console.error(`[mergeCollection] пропущен delete без id (${context}): ` + JSON.stringify(entry));
      continue;
    }
    const currentObj = byId.get(id);
    if (!currentObj) continue; // уже удалён (в т.ч. кем-то ещё) — конфликта нет, оба хотели одного
    const currentJson = JSON.stringify(currentObj);
    const baseJson = base ? JSON.stringify(base) : null;
    if (currentJson === baseJson) {
      byId.delete(id);
      deletedIds.push(id);
    } else {
      conflicts.push({ id, label: currentObj.label || id, action: "delete" });
    }
  }
  return { merged: [...byId.values()], conflicts, applied, deletedIds };
}

// Оборудование, удалённое из снимка модели, оставляло "осиротевшие" строки
// в monitor_status/monitor_events/monitor_tag_pulses навсегда — ничего их
// раньше не подчищало. Они не показываются как объект в списке (сам объект
// уже удалён), но их state/person_count/vehicle_count продолжали
// подмешиваться в общие суммы на странице "Мониторинг" (см. applyMonitorStatus
// в index.html), давая необъяснимое на вид расхождение вида "наверху
// написано 2 человека, а у видимых считывателей бейдж пустой".
function cleanupMonitorDataFor(projectId, equipmentIds) {
  if (!equipmentIds.length) return;
  const tx = db.transaction((ids) => {
    for (const id of ids) {
      db.prepare("DELETE FROM monitor_status WHERE project_id = ? AND equipment_id = ?").run(projectId, id);
      db.prepare("DELETE FROM monitor_events WHERE project_id = ? AND equipment_id = ?").run(projectId, id);
      db.prepare("DELETE FROM monitor_tag_pulses WHERE project_id = ? AND equipment_id = ?").run(projectId, id);
    }
  });
  tx(equipmentIds);
}

const EMPTY_SNAPSHOT = {
  version: 1,
  settings: {},
  layers: [],
  layersDTM: [],
  layersOBJ: [],
  cables: [],
  equipment: [],
  marks: [],
  patches: [],
};

router.put("/:id/state", requireRole("engineer", "admin", "supervisor"), (req, res) => {
  const project = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const body = req.body || {};
  const current = db
    .prepare("SELECT snapshot_json, version FROM project_state WHERE project_id = ?")
    .get(req.params.id);
  const currentSnapshot = current ? JSON.parse(current.snapshot_json) : EMPTY_SNAPSHOT;
  const currentVersion = current ? current.version : 0;
  const isAdmin = req.user.role === "admin" || req.user.role === "supervisor";

  const logCtx = `project=${req.params.id} user=${req.user.username} collection=`;
  const cablesResult = mergeCollection(currentSnapshot.cables, body.cables, logCtx + "cables");
  const equipmentResult = mergeCollection(currentSnapshot.equipment, body.equipment, logCtx + "equipment");
  const marksResult = mergeCollection(currentSnapshot.marks, body.marks, logCtx + "marks");
  // Заплатки — как и загрузка/удаление STR/DTM/OBJ-модели — инструмент
  // только для admin/supervisor (см. applyRoleToUI на фронтенде); правки
  // заплаток от engineer/viewer просто игнорируются, чтобы UI-ограничение
  // нельзя было обойти прямым вызовом API.
  const patchesResult = isAdmin
    ? mergeCollection(currentSnapshot.patches, body.patches, logCtx + "patches")
    : { merged: currentSnapshot.patches || [], conflicts: [], applied: [] };

  const nextSnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    settings: body.settings !== undefined ? body.settings : currentSnapshot.settings,
    layers: isAdmin && body.layers !== undefined ? body.layers : currentSnapshot.layers,
    layersDTM: isAdmin && body.layersDTM !== undefined ? body.layersDTM : currentSnapshot.layersDTM,
    layersOBJ: isAdmin && body.layersOBJ !== undefined ? body.layersOBJ : currentSnapshot.layersOBJ,
    cables: cablesResult.merged,
    equipment: equipmentResult.merged,
    marks: marksResult.merged,
    patches: patchesResult.merged,
  };

  const nextVersion = currentVersion + 1;
  db.prepare(
    `INSERT INTO project_state (project_id, snapshot_json, version, updated_by, updated_at)
     VALUES (@id, @json, @version, @by, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       snapshot_json = @json, version = @version, updated_by = @by, updated_at = datetime('now')`
  ).run({
    id: req.params.id,
    json: JSON.stringify(nextSnapshot),
    version: nextVersion,
    by: req.user.username,
  });
  cleanupMonitorDataFor(req.params.id, equipmentResult.deletedIds);

  const AUDIT_ENTITY_TYPES = { cables: "cable", equipment: "equipment", marks: "mark", patches: "patch" };
  for (const [collectionName, result] of Object.entries({ cables: cablesResult, equipment: equipmentResult, marks: marksResult, patches: patchesResult })) {
    const entityType = AUDIT_ENTITY_TYPES[collectionName];
    for (const change of result.applied) {
      logAudit({
        actor: req.user.username,
        projectId: req.params.id,
        action: `${entityType}.${change.kind}`,
        entityType,
        entityId: change.id,
        entityLabel: change.label,
        details: { before: change.before, after: change.after },
        ip: req.ip,
      });
    }
  }

  res.json({
    version: nextVersion,
    updatedBy: req.user.username,
    conflicts: {
      cables: cablesResult.conflicts,
      equipment: equipmentResult.conflicts,
      marks: marksResult.conflicts,
      patches: patchesResult.conflicts,
    },
    // Лёгкие коллекции (без геометрии модели) возвращаем целиком, чтобы
    // клиент мог обновить свою "базу" для следующего слияния — включая
    // объекты, которые в этом же сохранении добавили/поменяли другие люди.
    snapshot: {
      cables: nextSnapshot.cables,
      equipment: nextSnapshot.equipment,
      marks: nextSnapshot.marks,
      patches: nextSnapshot.patches,
    },
  });
});

const OBJECT_TYPES = new Set(["cable", "equipment", "mark", "patch"]);

router.post("/:id/deletions", requireRole("engineer", "admin", "supervisor"), (req, res) => {
  const project = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const { objectType, label, createdBy, createdAt } = req.body || {};
  if (!objectType || !OBJECT_TYPES.has(objectType)) {
    return res.status(400).json({ error: "invalid_object_type" });
  }
  db.prepare(
    `INSERT INTO deletion_log (project_id, object_type, label, created_by, created_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.params.id, objectType, label || "", createdBy || null, createdAt || null, req.user.username);
  logAudit({
    actor: req.user.username, projectId: req.params.id, action: `${objectType}.delete`,
    entityType: objectType, entityLabel: label || null, details: { createdBy, createdAt }, ip: req.ip,
  });

  res.status(201).json({ ok: true });
});

router.get("/:id/deletions", (req, res) => {
  const project = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const rows = db
    .prepare(
      `SELECT object_type, label, created_by, created_at, deleted_by, deleted_at
       FROM deletion_log WHERE project_id = ? ORDER BY deleted_at DESC, id DESC`
    )
    .all(req.params.id);
  res.json({ deletions: rows });
});

// Мониторинг оборудования (см. docs/monitoring-plan.md). На этом этапе
// таблицы существуют, но их ещё некому заполнять — коллекторы появятся на
// следующих этапах; эндпоинты уже отдают правильную (пустую) форму ответа,
// чтобы фронтенд мониторинга можно было строить не дожидаясь их реализации.
router.get("/:id/monitor/status", (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  // Тот же фильтр по getMonitoredEquipmentIds, что у WS-рассылки в
  // server.js — иначе "осиротевшие" строки monitor_status (удалённое/
  // переименованное оборудование или просто выключенный мониторинг)
  // подмешиваются в этот REST-фолбэк точно так же, как раньше в WS.
  const validIds = getMonitoredEquipmentIds(req.params.id);
  const rows = db
    .prepare(
      `SELECT equipment_id, state, last_checked_at, last_change_at, latency_ms,
              person_count, vehicle_count, raw_metrics_json
       FROM monitor_status WHERE project_id = ?`
    )
    .all(req.params.id)
    .filter((row) => validIds.has(row.equipment_id));
  res.json({ status: attachOpenEventAck(rows, req.params.id) });
});

// Подтверждение аварии ("я это вижу, разбираюсь") — отдельно от тикета:
// более лёгкий жест на активную аварию в списке/модалке статус-бара, без
// заведения полноценной заявки. Один раз проставляется и не снимается —
// событие закроется само (авария уйдёт), новая авария на этом же
// оборудовании — уже новая запись monitor_events, снова неподтверждённая.
router.post("/:id/monitor/events/:eventId/acknowledge", requireRole("engineer", "supervisor", "admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const event = db.prepare("SELECT id, acknowledged_by FROM monitor_events WHERE id = ? AND project_id = ?").get(req.params.eventId, req.params.id);
  if (!event) return res.status(404).json({ error: "event_not_found" });
  if (event.acknowledged_by) {
    return res.json({ ok: true, alreadyAcknowledged: true, acknowledgedBy: event.acknowledged_by });
  }

  const nowIso = new Date().toISOString();
  db.prepare("UPDATE monitor_events SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?").run(req.user.username, nowIso, event.id);
  logAudit({
    actor: req.user.username, projectId: req.params.id, action: "monitor_event.acknowledge",
    entityType: "monitor_events", entityId: event.id, ip: req.ip,
  });
  res.json({ ok: true, acknowledgedBy: req.user.username, acknowledgedAt: nowIso });
});

// Дашборд "История аварий" (/<project>/monitoring/stats) — сводка по системам
// связи/позиционирования (справочник monitor_systems, см. server/routes/
// references.js), та же группировка, что у кнопок фильтра на странице
// мониторинга (EQUIP_SHAPE_SYSTEMS в index.html грузится оттуда же через
// /api/references/monitor-systems/public). Раньше список систем и привязка
// формы оборудования к системе были захардкожены прямо здесь — снимок с
// тех времён, когда справочник ещё не завели в БД; из-за этого системы,
// добавленные/переназначенные через Настройки → Справочники, сюда не
// попадали. Теперь читаем monitor_systems/equipment_shape_systems напрямую.
// Оборудование одной формы может входить сразу в несколько систем (MAP —
// во все три), поэтому событие на нём учитывается в каждой из них; глобальные
// итоги считаются по уникальным id оборудования/событий, чтобы не задваивались.
function loadMonitorSystemsList() {
  return db.prepare("SELECT key FROM monitor_systems ORDER BY sort_order").all().map((r) => r.key);
}
function loadEquipShapeSystemsMap() {
  const rows = db.prepare("SELECT shape_key, system_key FROM equipment_shape_systems").all();
  const map = {};
  for (const r of rows) {
    if (!map[r.shape_key]) map[r.shape_key] = [];
    map[r.shape_key].push(r.system_key);
  }
  return map;
}
const MONITOR_STATS_RANGE_MS = { "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000 };
const MONITOR_STATS_SPARK_MS = 7 * 24 * 3600 * 1000;

// SQLite datetime('now') отдаёт "YYYY-MM-DD HH:MM:SS" (UTC, без T/Z) — тот же
// формат, что чинили на клиенте через parseServerDate(): без нормализации
// Date.parse() на сервере с TZ != UTC прочитал бы её как локальное время.
function parseMonitorDate(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  return m ? Date.parse(m[1] + "T" + m[2] + "Z") : Date.parse(s);
}

// equipmentId -> ["ВОЛС", ...] + счётчик отслеживаемого оборудования на
// систему — общее для /monitor/stats и /monitor/events (таблица одной
// системы), поэтому вынесено в одну функцию. systemsList — тоже отсюда,
// чтобы не запрашивать monitor_systems дважды на один HTTP-запрос.
function loadMonitorEquipSystems(projectId) {
  const systemsList = loadMonitorSystemsList();
  const shapeSystemsMap = loadEquipShapeSystemsMap();
  const stateRow = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  const equipment = stateRow ? JSON.parse(stateRow.snapshot_json).equipment || [] : [];
  const equipSystems = new Map();
  const monitoredCountBySystem = {};
  for (const sys of systemsList) monitoredCountBySystem[sys] = 0;
  for (const eq of equipment) {
    if (!eq.monitorMethod || eq.monitorMethod === "none") continue;
    const systems = shapeSystemsMap[eq.shape] || [];
    if (!systems.length) continue;
    equipSystems.set(eq.id, systems);
    for (const sys of systems) monitoredCountBySystem[sys]++;
  }
  return { systemsList, equipSystems, monitoredCountBySystem };
}

router.get("/:id/monitor/stats", (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const range = MONITOR_STATS_RANGE_MS[req.query.range] ? req.query.range : "7d";
  const rangeMs = MONITOR_STATS_RANGE_MS[range];
  const now = Date.now();
  const sinceMs = now - rangeMs;
  const sparkSinceMs = now - MONITOR_STATS_SPARK_MS;
  const fetchSinceMs = Math.min(sinceMs, sparkSinceMs);

  const { systemsList, equipSystems, monitoredCountBySystem } = loadMonitorEquipSystems(req.params.id);

  // Только "down" — это и есть авария; "up" лишь закрывает уже открытую
  // запись (см. server/monitor/*-worker.js), отдельной строки не создаёт.
  const events = db
    .prepare(
      `SELECT id, equipment_id, equipment_label, started_at, ended_at, duration_sec
       FROM monitor_events
       WHERE project_id = ? AND to_state = 'down' AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY started_at DESC`
    )
    .all(req.params.id, new Date(fetchSinceMs).toISOString());

  const perSystem = {};
  for (const sys of systemsList) {
    perSystem[sys] = { activeAlarms: [], recentEvents: [], incidentCount: 0, resolvedDurations: [], downtimeSec: 0, dailyCounts: new Array(7).fill(0) };
  }
  const dayMs = 24 * 3600 * 1000;
  const todayStartMs = Math.floor(now / dayMs) * dayMs;
  const activeIdsGlobal = new Set();
  const incidentIdsGlobal = new Set();

  for (const ev of events) {
    const systems = equipSystems.get(ev.equipment_id);
    if (!systems || !systems.length) continue;
    const startedMs = parseMonitorDate(ev.started_at);
    const endedMs = ev.ended_at ? parseMonitorDate(ev.ended_at) : now;
    const isActive = !ev.ended_at;
    const startedInRange = startedMs >= sinceMs;
    const startedInSparkWindow = startedMs >= sparkSinceMs;
    const overlapSec = Math.max(0, Math.min(endedMs, now) - Math.max(startedMs, sinceMs)) / 1000;
    const dayIndex = 6 - Math.round((todayStartMs - Math.floor(startedMs / dayMs) * dayMs) / dayMs);

    if (isActive) activeIdsGlobal.add(ev.equipment_id);
    if (startedInRange) incidentIdsGlobal.add(ev.id);

    for (const sys of systems) {
      const b = perSystem[sys];
      if (isActive) {
        b.activeAlarms.push({
          id: ev.id, equipmentId: ev.equipment_id, equipmentLabel: ev.equipment_label,
          startedAt: ev.started_at, durationSec: Math.round((now - startedMs) / 1000),
        });
      }
      if (startedInRange) {
        b.incidentCount++;
        if (!isActive) b.resolvedDurations.push(ev.duration_sec ?? Math.round(overlapSec));
      }
      if (overlapSec > 0) b.downtimeSec += overlapSec;
      if (startedInSparkWindow && dayIndex >= 0 && dayIndex < 7) b.dailyCounts[dayIndex]++;
      if (startedInRange || isActive) {
        b.recentEvents.push({
          id: ev.id, equipmentId: ev.equipment_id, equipmentLabel: ev.equipment_label,
          startedAt: ev.started_at, endedAt: ev.ended_at, durationSec: ev.duration_sec, active: isActive,
        });
      }
    }
  }

  const rangeSec = rangeMs / 1000;
  const systemsOut = {};
  let uptimeSum = 0, uptimeCount = 0;
  for (const sys of systemsList) {
    const b = perSystem[sys];
    const monitoredCount = monitoredCountBySystem[sys] || 0;
    const totalPossibleSec = monitoredCount * rangeSec;
    const uptimePct = totalPossibleSec > 0 ? Math.max(0, 100 - (b.downtimeSec / totalPossibleSec) * 100) : null;
    const avgResolutionSec = b.resolvedDurations.length
      ? Math.round(b.resolvedDurations.reduce((a, c) => a + c, 0) / b.resolvedDurations.length)
      : null;
    b.recentEvents.sort((a, c) => (c.startedAt || "").localeCompare(a.startedAt || ""));
    b.activeAlarms.sort((a, c) => (a.startedAt || "").localeCompare(c.startedAt || ""));
    systemsOut[sys] = {
      monitoredCount,
      activeAlarms: b.activeAlarms,
      recentEvents: b.recentEvents.slice(0, 6),
      incidentCount: b.incidentCount,
      avgResolutionSec,
      uptimePct: uptimePct === null ? null : Math.round(uptimePct * 100) / 100,
      dailyCounts: b.dailyCounts,
    };
    if (uptimePct !== null) { uptimeSum += uptimePct; uptimeCount++; }
  }

  res.json({
    range,
    since: new Date(sinceMs).toISOString(),
    systemsList,
    systems: systemsOut,
    totals: {
      activeNow: activeIdsGlobal.size,
      incidentsInRange: incidentIdsGlobal.size,
      avgUptimePct: uptimeCount ? Math.round((uptimeSum / uptimeCount) * 100) / 100 : null,
    },
  });
});

// Таблица всех событий одной системы — открывается кликом по плитке на
// дашборде /<project>/monitoring/stats. ?system= без значения (или "all")
// отдаёт вообще все аварии проекта. Возвращает полный список за диапазон
// (без среза до 6, как в /monitor/stats), включая ещё не закрытые.
router.get("/:id/monitor/events", (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const range = MONITOR_STATS_RANGE_MS[req.query.range] ? req.query.range : "7d";
  const rangeMs = MONITOR_STATS_RANGE_MS[range];
  const now = Date.now();
  const sinceMs = now - rangeMs;
  const { systemsList, equipSystems } = loadMonitorEquipSystems(req.params.id);
  const system = req.query.system && req.query.system !== "all" ? req.query.system : null;
  if (system && !systemsList.includes(system)) {
    return res.status(400).json({ error: "invalid_system" });
  }

  const rows = db
    .prepare(
      `SELECT id, equipment_id, equipment_label, started_at, ended_at, duration_sec
       FROM monitor_events
       WHERE project_id = ? AND to_state = 'down' AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY started_at DESC`
    )
    .all(req.params.id, new Date(sinceMs).toISOString());

  const events = [];
  for (const ev of rows) {
    const systems = equipSystems.get(ev.equipment_id);
    if (!systems || !systems.length) continue;
    if (system && !systems.includes(system)) continue;
    const isActive = !ev.ended_at;
    const startedMs = parseMonitorDate(ev.started_at);
    if (!isActive && startedMs < sinceMs) continue;
    events.push({
      id: ev.id,
      equipmentId: ev.equipment_id,
      equipmentLabel: ev.equipment_label,
      systems,
      startedAt: ev.started_at,
      endedAt: ev.ended_at,
      durationSec: isActive ? Math.round((now - startedMs) / 1000) : ev.duration_sec,
      active: isActive,
    });
  }

  res.json({ range, system: system || "all", events });
});

// Пороги фиксации аварии — per-project (см. project_monitor_thresholds в
// db.js). Статус на дашборде/3D всегда живой (сырой пинг/SPPD-сигнал);
// pingFailDurationSec — сколько секунд непрерывного простоя нужно набрать,
// прежде чем это запишется как авария в monitor_events (а не просто мигнёт
// красным на один пропавший пакет). Отсутствие строки означает "используются
// дефолты воркеров", поэтому GET всегда возвращает конкретные числа (дефолт,
// если не настроено), а не null — воркеры (ping-worker.js,
// custom-monitor-worker.js) читают эту же таблицу напрямую и точно так же
// откатываются к дефолтам.
const THRESHOLD_DEFAULTS = {
  pingTimeoutSec: 1,
  pingFailDurationSec: 300,
  customStaleAfterSec: 120,
  customFailDurationSec: 300,
  lampFailAfterHours: 24,
  ticketSlaCriticalHours: 2,
  ticketSlaHighHours: 8,
  ticketSlaMediumHours: 24,
  ticketSlaLowHours: 72,
};

function serializeThresholds(row) {
  if (!row) return Object.assign({ configured: false }, THRESHOLD_DEFAULTS);
  return {
    configured: true,
    pingTimeoutSec: row.ping_timeout_sec,
    pingFailDurationSec: row.ping_fail_duration_sec,
    customStaleAfterSec: row.custom_stale_after_sec,
    customFailDurationSec: row.custom_fail_duration_sec,
    lampFailAfterHours: row.lamp_fail_after_hours,
    ticketSlaCriticalHours: row.ticket_sla_critical_hours,
    ticketSlaHighHours: row.ticket_sla_high_hours,
    ticketSlaMediumHours: row.ticket_sla_medium_hours,
    ticketSlaLowHours: row.ticket_sla_low_hours,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

router.get("/:id/monitor/thresholds", requireRole("admin", "supervisor"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const row = db.prepare("SELECT * FROM project_monitor_thresholds WHERE project_id = ?").get(req.params.id);
  res.json(serializeThresholds(row));
});

router.put("/:id/monitor/thresholds", requireRole("admin", "supervisor"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const {
    pingTimeoutSec, pingFailDurationSec, customStaleAfterSec, customFailDurationSec, lampFailAfterHours,
    ticketSlaCriticalHours, ticketSlaHighHours, ticketSlaMediumHours, ticketSlaLowHours,
  } = req.body || {};
  if (!Number.isInteger(pingTimeoutSec) || pingTimeoutSec < 1 || pingTimeoutSec > 10) {
    return res.status(400).json({ error: "invalid_ping_timeout_sec" });
  }
  // 0 разрешён явно — "фиксировать аварию сразу", как было раньше до этой
  // настройки, для тех, кому debounce не нужен.
  if (!Number.isInteger(pingFailDurationSec) || pingFailDurationSec < 0 || pingFailDurationSec > 3600) {
    return res.status(400).json({ error: "invalid_ping_fail_duration_sec" });
  }
  if (!Number.isInteger(customStaleAfterSec) || customStaleAfterSec < 30 || customStaleAfterSec > 3600) {
    return res.status(400).json({ error: "invalid_custom_stale_after_sec" });
  }
  if (!Number.isInteger(customFailDurationSec) || customFailDurationSec < 0 || customFailDurationSec > 3600) {
    return res.status(400).json({ error: "invalid_custom_fail_duration_sec" });
  }
  if (!Number.isInteger(lampFailAfterHours) || lampFailAfterHours < 1 || lampFailAfterHours > 336) {
    return res.status(400).json({ error: "invalid_lamp_fail_after_hours" });
  }
  for (const [key, val] of Object.entries({ ticketSlaCriticalHours, ticketSlaHighHours, ticketSlaMediumHours, ticketSlaLowHours })) {
    if (!Number.isInteger(val) || val < 1 || val > 720) {
      return res.status(400).json({ error: `invalid_${key.replace(/([A-Z])/g, "_$1").toLowerCase()}` });
    }
  }

  db.prepare(
    `INSERT INTO project_monitor_thresholds
       (project_id, ping_timeout_sec, ping_fail_duration_sec, custom_stale_after_sec, custom_fail_duration_sec, lamp_fail_after_hours,
        ticket_sla_critical_hours, ticket_sla_high_hours, ticket_sla_medium_hours, ticket_sla_low_hours, updated_by, updated_at)
     VALUES (@id, @pingTimeoutSec, @pingFailDurationSec, @customStaleAfterSec, @customFailDurationSec, @lampFailAfterHours,
             @ticketSlaCriticalHours, @ticketSlaHighHours, @ticketSlaMediumHours, @ticketSlaLowHours, @by, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       ping_timeout_sec = @pingTimeoutSec, ping_fail_duration_sec = @pingFailDurationSec,
       custom_stale_after_sec = @customStaleAfterSec, custom_fail_duration_sec = @customFailDurationSec,
       lamp_fail_after_hours = @lampFailAfterHours,
       ticket_sla_critical_hours = @ticketSlaCriticalHours, ticket_sla_high_hours = @ticketSlaHighHours,
       ticket_sla_medium_hours = @ticketSlaMediumHours, ticket_sla_low_hours = @ticketSlaLowHours,
       updated_by = @by, updated_at = datetime('now')`
  ).run({
    id: req.params.id,
    pingTimeoutSec, pingFailDurationSec, customStaleAfterSec, customFailDurationSec, lampFailAfterHours,
    ticketSlaCriticalHours, ticketSlaHighHours, ticketSlaMediumHours, ticketSlaLowHours,
    by: req.user.username,
  });

  const row = db.prepare("SELECT * FROM project_monitor_thresholds WHERE project_id = ?").get(req.params.id);
  logAudit({
    actor: req.user.username, projectId: req.params.id, action: "thresholds.update",
    entityType: "thresholds", details: serializeThresholds(row), ip: req.ip,
  });
  res.json(serializeThresholds(row));
});

router.delete("/:id/monitor/thresholds", requireRole("admin", "supervisor"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  db.prepare("DELETE FROM project_monitor_thresholds WHERE project_id = ?").run(req.params.id);
  logAudit({ actor: req.user.username, projectId: req.params.id, action: "thresholds.reset", entityType: "thresholds", ip: req.ip });
  res.json(serializeThresholds(null));
});

// Пер-формные переопределения порогов (модуль "Настройки" → Пороги, см.
// project_shape_thresholds в db.js) — необязательные overrides на (project,
// shape), null-поле значит "использовать дефолт проекта". Ping-worker.js и
// custom-monitor-worker.js читают эту таблицу напрямую (server/lib/
// monitorShared.js), эти роуты — только для UI.
router.get("/:id/monitor/shape-thresholds", requireRole("admin", "supervisor"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const rows = db
    .prepare("SELECT shape, stale_after_sec, fail_duration_sec, updated_by, updated_at FROM project_shape_thresholds WHERE project_id = ? ORDER BY shape")
    .all(req.params.id);
  res.json({
    overrides: rows.map((r) => ({
      shape: r.shape,
      staleAfterSec: r.stale_after_sec,
      failDurationSec: r.fail_duration_sec,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    })),
  });
});

router.put("/:id/monitor/shape-thresholds/:shape", requireRole("admin", "supervisor"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const { staleAfterSec, failDurationSec } = req.body || {};
  // Оба поля необязательны — null/undefined означает "не переопределять",
  // используется дефолт проекта. Если оба пустые, проще удалить строку.
  const staleVal = staleAfterSec === null || staleAfterSec === undefined || staleAfterSec === "" ? null : parseInt(staleAfterSec, 10);
  const failVal = failDurationSec === null || failDurationSec === undefined || failDurationSec === "" ? null : parseInt(failDurationSec, 10);
  if (staleVal !== null && (!Number.isInteger(staleVal) || staleVal < 30 || staleVal > 3600)) {
    return res.status(400).json({ error: "invalid_stale_after_sec" });
  }
  if (failVal !== null && (!Number.isInteger(failVal) || failVal < 0 || failVal > 3600)) {
    return res.status(400).json({ error: "invalid_fail_duration_sec" });
  }
  if (staleVal === null && failVal === null) {
    db.prepare("DELETE FROM project_shape_thresholds WHERE project_id = ? AND shape = ?").run(req.params.id, req.params.shape);
    logAudit({
      actor: req.user.username, projectId: req.params.id, action: "shape_thresholds.reset",
      entityType: "shape_thresholds", entityId: req.params.shape, ip: req.ip,
    });
    return res.json({ ok: true, cleared: true });
  }

  db.prepare(
    `INSERT INTO project_shape_thresholds (project_id, shape, stale_after_sec, fail_duration_sec, updated_by, updated_at)
     VALUES (@projectId, @shape, @staleVal, @failVal, @by, datetime('now'))
     ON CONFLICT(project_id, shape) DO UPDATE SET
       stale_after_sec = @staleVal, fail_duration_sec = @failVal, updated_by = @by, updated_at = datetime('now')`
  ).run({ projectId: req.params.id, shape: req.params.shape, staleVal, failVal, by: req.user.username });
  logAudit({
    actor: req.user.username, projectId: req.params.id, action: "shape_thresholds.update",
    entityType: "shape_thresholds", entityId: req.params.shape,
    details: { staleAfterSec: staleVal, failDurationSec: failVal }, ip: req.ip,
  });
  res.json({ ok: true });
});

// Ручная раскладка схемы связей (см. public/schema.html, Фаза 4) — координаты
// узлов, которые пользователь перетащил мышью. Чтение доступно любой
// авторизованной роли (как и сама схема), правка — как редактирование модели
// (engineer/supervisor/admin), см. requireRole ниже.
router.get("/:id/schema-layout", (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const rows = db
    .prepare("SELECT equipment_id, x, y FROM schema_layout_overrides WHERE project_id = ?")
    .all(req.params.id);
  const positions = {};
  for (const r of rows) positions[r.equipment_id] = { x: r.x, y: r.y };
  res.json({ positions });
});

router.put("/:id/schema-layout/:equipmentId", requireRole("engineer", "supervisor", "admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const { x, y } = req.body || {};
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: "invalid_coordinates" });
  }
  db.prepare(
    `INSERT INTO schema_layout_overrides (project_id, equipment_id, x, y, updated_by, updated_at)
     VALUES (@projectId, @equipmentId, @x, @y, @by, datetime('now'))
     ON CONFLICT(project_id, equipment_id) DO UPDATE SET
       x = @x, y = @y, updated_by = @by, updated_at = datetime('now')`
  ).run({ projectId: req.params.id, equipmentId: req.params.equipmentId, x, y, by: req.user.username });
  res.json({ ok: true });
});

// Открепить один узел (вернуть его под автоматическую раскладку) — отдельно
// от полного сброса ниже, чтобы можно было поправить один "убежавший" узел,
// не теряя расстановку остальных.
router.delete("/:id/schema-layout/:equipmentId", requireRole("engineer", "supervisor", "admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  db.prepare("DELETE FROM schema_layout_overrides WHERE project_id = ? AND equipment_id = ?").run(req.params.id, req.params.equipmentId);
  res.json({ ok: true });
});

router.delete("/:id/schema-layout", requireRole("engineer", "supervisor", "admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  db.prepare("DELETE FROM schema_layout_overrides WHERE project_id = ?").run(req.params.id);
  logAudit({ actor: req.user.username, projectId: req.params.id, action: "schema_layout.reset", entityType: "schema_layout", ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
