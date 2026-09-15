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
function mergeCollection(baseArr, incoming) {
  const byId = new Map((baseArr || []).map((o) => [o.id, o]));
  const conflicts = [];
  for (const entry of (incoming && incoming.upserts) || []) {
    const { id, data, base } = entry || {};
    if (!id || !data) continue;
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
    if (!id) continue;
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

  const cablesResult = mergeCollection(currentSnapshot.cables, body.cables);
  const equipmentResult = mergeCollection(currentSnapshot.equipment, body.equipment);
  const marksResult = mergeCollection(currentSnapshot.marks, body.marks);
  // Заплатки — как и загрузка/удаление STR/DTM/OBJ-модели — инструмент
  // только для admin (см. applyRoleToUI на фронтенде); правки заплаток от
  // не-admin просто игнорируются, чтобы UI-ограничение нельзя было обойти
  // прямым вызовом API.
  const patchesResult = isAdmin
    ? mergeCollection(currentSnapshot.patches, body.patches)
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

module.exports = router;
