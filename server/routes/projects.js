const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();
const SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;

router.use(requireAuth);

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

router.put("/:id/state", requireRole("editor", "admin"), (req, res) => {
  const project = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const { snapshot, baseVersion } = req.body || {};
  if (snapshot === undefined) {
    return res.status(400).json({ error: "missing_snapshot" });
  }

  const current = db
    .prepare("SELECT version, updated_by, updated_at FROM project_state WHERE project_id = ?")
    .get(req.params.id);
  const currentVersion = current ? current.version : 0;

  if (typeof baseVersion === "number" && baseVersion !== currentVersion) {
    return res.status(409).json({
      error: "version_conflict",
      currentVersion,
      updatedBy: current ? current.updated_by : null,
      updatedAt: current ? current.updated_at : null,
    });
  }

  // Загрузка/удаление STR-модели ("layers"/"layersDTM") и заплатки
  // ("patches") — только для admin. editor может редактировать
  // кабели/оборудование/метки/настройки, но не эти поля: если запрос
  // пришёл не от admin, эти части снапшота берём из текущей сохранённой
  // версии, а не из тела запроса, чтобы UI-ограничение нельзя было обойти
  // прямым вызовом API.
  if (req.user.role !== "admin") {
    const existing = current
      ? JSON.parse(
          db
            .prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?")
            .get(req.params.id).snapshot_json
        )
      : null;
    snapshot.layers = existing ? existing.layers : [];
    snapshot.layersDTM = existing ? existing.layersDTM : [];
    snapshot.patches = existing ? existing.patches : [];
  }

  const nextVersion = currentVersion + 1;
  const snapshotJson = JSON.stringify(snapshot);
  db.prepare(
    `INSERT INTO project_state (project_id, snapshot_json, version, updated_by, updated_at)
     VALUES (@id, @json, @version, @by, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       snapshot_json = @json, version = @version, updated_by = @by, updated_at = datetime('now')`
  ).run({
    id: req.params.id,
    json: snapshotJson,
    version: nextVersion,
    by: req.user.username,
  });

  res.json({ version: nextVersion, updatedBy: req.user.username });
});

module.exports = router;
