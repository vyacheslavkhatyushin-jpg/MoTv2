/*
Настройки → Проекты (admin) — список проектов с количеством данных по
блокам и точечная очистка отдельных блоков без полного удаления проекта.
Полное удаление проекта намеренно осталось только в консоли
(server/delete-project.js) — слишком легко нажать по ошибке, когда речь о
каскадном стирании всей модели.

Самые разрушительные операции (объекты модели по типам, история
мониторинга) требуют повторного ввода пароля текущего админа — проверяется
прямо в теле запроса (bcrypt против users.password_hash), без отдельного
эндпоинта на "подтверждение": неверный пароль просто ничего не удаляет и
возвращает 403 (НЕ 401 — тот глобально перехватывается apiFetch() в
settings.html как "сессия истекла" и разлогинивает, что здесь совсем не
к месту: пароль неверный, а не токен).
*/
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const { loadProject, saveProject } = require("../lib/snapshot-store");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function checkPassword(userId, password) {
  if (!password) return false;
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
  return !!row && bcrypt.compareSync(password, row.password_hash);
}

function projectCounts(projectId) {
  const snap = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  let cables = 0, equipment = 0, marks = 0, patches = 0;
  if (snap) {
    try {
      const parsed = JSON.parse(snap.snapshot_json);
      cables = (parsed.cables || []).length;
      equipment = (parsed.equipment || []).length;
      marks = (parsed.marks || []).length;
      patches = (parsed.patches || []).length;
    } catch (e) { /* повреждённый снимок — считаем как пустой, не валим список проектов */ }
  }
  return {
    cables, equipment, marks, patches,
    monitorEvents: db.prepare("SELECT COUNT(*) c FROM monitor_events WHERE project_id = ?").get(projectId).c,
    ticketsOpen: db.prepare("SELECT COUNT(*) c FROM tickets WHERE project_id = ? AND status NOT IN ('closed','cancelled')").get(projectId).c,
    ticketsClosed: db.prepare("SELECT COUNT(*) c FROM tickets WHERE project_id = ? AND status IN ('closed','cancelled')").get(projectId).c,
    lampReports: db.prepare("SELECT COUNT(*) c FROM lamp_reports WHERE project_id = ?").get(projectId).c,
    auditLog: db.prepare("SELECT COUNT(*) c FROM audit_log WHERE project_id = ?").get(projectId).c,
  };
}

router.get("/projects", (req, res) => {
  const projects = db.prepare("SELECT id, name, created_at FROM projects ORDER BY name").all();
  res.json({ projects: projects.map((p) => ({ ...p, counts: projectCounts(p.id) })) });
});

router.get("/projects/:id/types", (req, res) => {
  const projectId = req.params.id;
  const project = loadProject(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const cableLabels = new Map(db.prepare("SELECT key, label FROM cable_types").all().map((r) => [r.key, r.label]));
  const equipLabels = new Map(db.prepare("SELECT key, label FROM equipment_shapes").all().map((r) => [r.key, r.label]));

  const countBy = (list, keyField, labels) => {
    const counts = new Map();
    for (const obj of list) {
      const key = obj[keyField] || "—";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, label: labels.get(key) || key, count }))
      .sort((a, b) => b.count - a.count);
  };

  res.json({
    cableTypes: countBy(project.snapshot.cables || [], "cableType", cableLabels),
    equipShapes: countBy(project.snapshot.equipment || [], "shape", equipLabels),
  });
});

router.put("/projects/:id", (req, res) => {
  const projectId = req.params.id;
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "missing_name" });
  const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name.trim(), projectId);
  logAudit({
    actor: req.user.username, projectId, action: "project.rename", entityType: "project", entityId: projectId,
    entityLabel: name.trim(), details: { from: project.name, to: name.trim() }, ip: req.ip,
  });
  res.json({ id: projectId, name: name.trim() });
});

// Удаление объектов модели по типам кабелей/форм оборудования — не трогает
// остальную модель (метки/заплатки и прочие типы/формы остаются как есть).
router.post("/projects/:id/model/delete-by-type", (req, res) => {
  const projectId = req.params.id;
  const { password, cableTypes, equipShapes } = req.body || {};
  if (!checkPassword(req.user.sub, password)) return res.status(403).json({ error: "invalid_password" });

  const project = loadProject(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const cableSet = new Set(cableTypes || []);
  const equipSet = new Set(equipShapes || []);
  if (!cableSet.size && !equipSet.size) return res.status(400).json({ error: "nothing_selected" });

  const removedCables = cableSet.size ? (project.snapshot.cables || []).filter((c) => cableSet.has(c.cableType)) : [];
  const removedEquip = equipSet.size ? (project.snapshot.equipment || []).filter((e) => equipSet.has(e.shape)) : [];

  if (cableSet.size) project.snapshot.cables = (project.snapshot.cables || []).filter((c) => !cableSet.has(c.cableType));
  if (equipSet.size) project.snapshot.equipment = (project.snapshot.equipment || []).filter((e) => !equipSet.has(e.shape));

  const nextVersion = saveProject(projectId, project.snapshot, project.version, req.user.username);

  const insertDeletion = db.prepare(
    `INSERT INTO deletion_log (project_id, object_type, label, created_by, created_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const logDeletions = db.transaction(() => {
    for (const c of removedCables) insertDeletion.run(projectId, "cable", c.label || "", c.createdBy || null, c.createdAt || null, req.user.username);
    for (const e of removedEquip) insertDeletion.run(projectId, "equipment", e.label || "", e.createdBy || null, e.createdAt || null, req.user.username);
  });
  logDeletions();

  // Оборудование удалено — его мониторинговые данные осиротели, чистим так
  // же, как при обычном удалении оборудования через редактор (см.
  // cleanupMonitorDataFor в routes/projects.js).
  const equipIds = removedEquip.map((e) => e.id).filter(Boolean);
  if (equipIds.length) {
    const cleanupTx = db.transaction((ids) => {
      for (const id of ids) {
        db.prepare("DELETE FROM monitor_status WHERE project_id = ? AND equipment_id = ?").run(projectId, id);
        db.prepare("DELETE FROM monitor_events WHERE project_id = ? AND equipment_id = ?").run(projectId, id);
        db.prepare("DELETE FROM monitor_tag_pulses WHERE project_id = ? AND equipment_id = ?").run(projectId, id);
      }
    });
    cleanupTx(equipIds);
  }

  logAudit({
    actor: req.user.username, projectId, action: "project.model.delete_by_type", entityType: "project_state", entityId: projectId,
    details: { cableTypes: [...cableSet], equipShapes: [...equipSet], removedCables: removedCables.length, removedEquip: removedEquip.length },
    ip: req.ip,
  });
  res.json({ ok: true, removedCables: removedCables.length, removedEquip: removedEquip.length, version: nextVersion });
});

router.post("/projects/:id/monitoring/clear", (req, res) => {
  const projectId = req.params.id;
  const { password } = req.body || {};
  if (!checkPassword(req.user.sub, password)) return res.status(403).json({ error: "invalid_password" });
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const removed = db.prepare("DELETE FROM monitor_events WHERE project_id = ?").run(projectId).changes;
  db.prepare("DELETE FROM monitor_tag_pulses WHERE project_id = ?").run(projectId);
  logAudit({ actor: req.user.username, projectId, action: "project.monitoring.clear", entityType: "monitor_events", details: { removed }, ip: req.ip });
  res.json({ ok: true, removed });
});

router.post("/projects/:id/tickets/clear-closed", (req, res) => {
  const projectId = req.params.id;
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  // ticket_comments/ticket_attachments каскадятся через ticket_id ON DELETE CASCADE.
  const removed = db.prepare("DELETE FROM tickets WHERE project_id = ? AND status IN ('closed','cancelled')").run(projectId).changes;
  logAudit({ actor: req.user.username, projectId, action: "project.tickets.clear_closed", entityType: "tickets", details: { removed }, ip: req.ip });
  res.json({ ok: true, removed });
});

router.post("/projects/:id/lamps/clear", (req, res) => {
  const projectId = req.params.id;
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  // lamp_records каскадится через report_id → lamp_reports.id ON DELETE CASCADE.
  const removed = db.prepare("DELETE FROM lamp_reports WHERE project_id = ?").run(projectId).changes;
  logAudit({ actor: req.user.username, projectId, action: "project.lamps.clear", entityType: "lamp_reports", details: { removed }, ip: req.ip });
  res.json({ ok: true, removed });
});

router.post("/projects/:id/audit/clear", (req, res) => {
  const projectId = req.params.id;
  const olderThanDays = Number(req.body && req.body.olderThanDays) || 90;
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) return res.status(400).json({ error: "invalid_older_than_days" });
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const removed = db.prepare(
    "DELETE FROM audit_log WHERE project_id = ? AND created_at < datetime('now', ?)"
  ).run(projectId, `-${olderThanDays} days`).changes;
  logAudit({ actor: req.user.username, projectId, action: "project.audit.clear", entityType: "audit_log", details: { removed, olderThanDays }, ip: req.ip });
  res.json({ ok: true, removed });
});

module.exports = router;
