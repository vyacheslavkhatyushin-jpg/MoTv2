const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");

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

router.post("/", requireRole("admin"), (req, res) => {
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
function mergeCollection(baseArr, incoming, context) {
  const byId = new Map((baseArr || []).map((o) => [o.id, o]));
  const conflicts = [];
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
    } else {
      conflicts.push({ id, label: currentObj.label || id, action: "delete" });
    }
  }
  return { merged: [...byId.values()], conflicts };
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

router.put("/:id/state", requireRole("editor", "admin"), (req, res) => {
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
  const isAdmin = req.user.role === "admin";

  const logCtx = `project=${req.params.id} user=${req.user.username} collection=`;
  const cablesResult = mergeCollection(currentSnapshot.cables, body.cables, logCtx + "cables");
  const equipmentResult = mergeCollection(currentSnapshot.equipment, body.equipment, logCtx + "equipment");
  const marksResult = mergeCollection(currentSnapshot.marks, body.marks, logCtx + "marks");
  // Заплатки — как и загрузка/удаление STR/DTM/OBJ-модели — инструмент
  // только для admin (см. applyRoleToUI на фронтенде); правки заплаток от
  // не-admin просто игнорируются, чтобы UI-ограничение нельзя было обойти
  // прямым вызовом API.
  const patchesResult = isAdmin
    ? mergeCollection(currentSnapshot.patches, body.patches, logCtx + "patches")
    : { merged: currentSnapshot.patches || [], conflicts: [] };

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

router.post("/:id/deletions", requireRole("editor", "admin"), (req, res) => {
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

  const rows = db
    .prepare(
      `SELECT equipment_id, state, last_checked_at, last_change_at, latency_ms,
              person_count, vehicle_count, raw_metrics_json
       FROM monitor_status WHERE project_id = ?`
    )
    .all(req.params.id);
  res.json({ status: rows });
});

router.get("/:id/monitor/events", (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const rows = db
    .prepare(
      `SELECT id, equipment_id, equipment_label, from_state, to_state,
              started_at, ended_at, duration_sec, acknowledged_by, acknowledged_at
       FROM monitor_events WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 500`
    )
    .all(req.params.id);
  res.json({ events: rows });
});

// Дашборд "История аварий" (/<project>/monitoring/stats) — сводка по пяти
// системам (ВОЛС/LFC/АО/Телефония/ВН), та же группировка, что у кнопок
// фильтра на странице мониторинга (EQUIP_SHAPE_SYSTEMS в index.html — этот
// список продублирован здесь, т.к. страницы не делят JS-модули между собой).
// Оборудование одной формы может входить сразу в несколько систем (MAP —
// во все три), поэтому событие на нём учитывается в каждой из них; глобальные
// итоги считаются по уникальным id оборудования/событий, чтобы не задваивались.
const MONITOR_SYSTEMS_LIST = ["ВОЛС", "LFC", "АО", "Телефония", "ВН"];
const MONITOR_EQUIP_SHAPE_SYSTEMS = {
  map: ["ВОЛС", "Телефония", "ВН"],
  odf: ["ВОЛС"],
  wifi: ["ВОЛС"],
  mla: ["LFC"], iilb: ["LFC"], isib: ["LFC"], mps: ["LFC"], mpc: ["LFC"],
  mtu: ["LFC"], mvsa: ["LFC"], mbu: ["LFC"],
  stativ: ["LFC", "АО"],
  fs: ["АО"],
  tel: ["Телефония"],
  cam: ["ВН"],
};
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

router.get("/:id/monitor/stats", (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const range = MONITOR_STATS_RANGE_MS[req.query.range] ? req.query.range : "7d";
  const rangeMs = MONITOR_STATS_RANGE_MS[range];
  const now = Date.now();
  const sinceMs = now - rangeMs;
  const sparkSinceMs = now - MONITOR_STATS_SPARK_MS;
  const fetchSinceMs = Math.min(sinceMs, sparkSinceMs);

  const stateRow = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(req.params.id);
  const equipment = stateRow ? JSON.parse(stateRow.snapshot_json).equipment || [] : [];
  const equipSystems = new Map(); // equipmentId -> ["ВОЛС", ...]
  const monitoredCountBySystem = {};
  for (const sys of MONITOR_SYSTEMS_LIST) monitoredCountBySystem[sys] = 0;
  for (const eq of equipment) {
    if (!eq.monitorMethod || eq.monitorMethod === "none") continue;
    const systems = MONITOR_EQUIP_SHAPE_SYSTEMS[eq.shape] || [];
    if (!systems.length) continue;
    equipSystems.set(eq.id, systems);
    for (const sys of systems) monitoredCountBySystem[sys]++;
  }

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
  for (const sys of MONITOR_SYSTEMS_LIST) {
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
          equipmentId: ev.equipment_id, equipmentLabel: ev.equipment_label,
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
          equipmentId: ev.equipment_id, equipmentLabel: ev.equipment_label,
          startedAt: ev.started_at, endedAt: ev.ended_at, durationSec: ev.duration_sec, active: isActive,
        });
      }
    }
  }

  const rangeSec = rangeMs / 1000;
  const systemsOut = {};
  let uptimeSum = 0, uptimeCount = 0;
  for (const sys of MONITOR_SYSTEMS_LIST) {
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
    systems: systemsOut,
    totals: {
      activeNow: activeIdsGlobal.size,
      incidentsInRange: incidentIdsGlobal.size,
      avgUptimePct: uptimeCount ? Math.round((uptimeSum / uptimeCount) * 100) / 100 : null,
    },
  });
});

// Настройка подключения к SPPD для этого проекта (Этап 4, см.
// docs/monitoring-plan.md) — у каждой шахты свой сервер SPPD, поэтому это
// per-project настройка, а не общая переменная окружения одного воркера.
// Пароль отдаём только на запись: GET сообщает лишь факт, что что-то
// настроено (не значение), чтобы не светить его в ответе каждому админу,
// который просто открыл форму.
router.get("/:id/monitor/sppd-config", requireRole("admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const row = db
    .prepare("SELECT base_url, username, updated_by, updated_at FROM project_sppd_config WHERE project_id = ?")
    .get(req.params.id);
  if (!row) return res.json({ configured: false, baseUrl: null, username: null });
  res.json({
    configured: true,
    baseUrl: row.base_url,
    username: row.username,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
});

router.put("/:id/monitor/sppd-config", requireRole("admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const { baseUrl, username, password } = req.body || {};
  if (!baseUrl || !/^https?:\/\/\S+$/.test(baseUrl)) {
    return res.status(400).json({ error: "invalid_base_url" });
  }
  if (!username || !username.trim()) {
    return res.status(400).json({ error: "missing_username" });
  }
  const existing = db.prepare("SELECT password FROM project_sppd_config WHERE project_id = ?").get(req.params.id);
  // Пароль необязателен при обновлении — пустое поле в форме означает
  // "оставить как есть", а не "стереть пароль". Обязателен только при
  // первой настройке, когда сохранять нечего.
  const nextPassword = password || (existing && existing.password);
  if (!nextPassword) {
    return res.status(400).json({ error: "missing_password" });
  }

  db.prepare(
    `INSERT INTO project_sppd_config (project_id, base_url, username, password, updated_by, updated_at)
     VALUES (@id, @baseUrl, @username, @password, @by, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       base_url = @baseUrl, username = @username, password = @password,
       updated_by = @by, updated_at = datetime('now')`
  ).run({
    id: req.params.id,
    baseUrl: baseUrl.trim(),
    username: username.trim(),
    password: nextPassword,
    by: req.user.username,
  });

  res.json({ ok: true });
});

router.delete("/:id/monitor/sppd-config", requireRole("admin"), (req, res) => {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  db.prepare("DELETE FROM project_sppd_config WHERE project_id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
