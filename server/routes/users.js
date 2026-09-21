const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");

const router = express.Router();
const ROLES = new Set(["viewer", "engineer", "supervisor", "admin"]);

// Лёгкий список для выпадающего списка "исполнитель" в тикетах — доступен
// admin/supervisor (они назначают исполнителей), но НЕ идёт через общий
// router.use(requireRole("admin")) ниже: раздел "Пользователи" (создание/
// смена роли/удаление, полный /api/users) остаётся строго admin-only, а
// назначение тикетов — отдельная функция, которую supervisor обязан иметь.
router.get("/assignable", requireAuth, requireRole("admin", "supervisor"), (req, res) => {
  const users = db
    .prepare("SELECT username, role FROM users WHERE role != 'viewer' ORDER BY username")
    .all();
  res.json({ users });
});

router.use(requireAuth, requireRole("admin"));

router.get("/", (req, res) => {
  const users = db
    .prepare("SELECT id, username, role, created_at FROM users ORDER BY username")
    .all();
  res.json({ users });
});

router.post("/", (req, res) => {
  const { username, password, role } = req.body || {};
  const name = String(username || "").trim();
  if (!name) return res.status(400).json({ error: "missing_username" });
  if (!password || password.length < 4) return res.status(400).json({ error: "weak_password" });
  if (!ROLES.has(role)) return res.status(400).json({ error: "invalid_role" });
  const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(name);
  if (exists) return res.status(409).json({ error: "already_exists" });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run(name, hash, role);
  logAudit({ actor: req.user.username, action: "user.create", entityType: "user", entityId: name, entityLabel: name, details: { role }, ip: req.ip });
  res.status(201).json({ ok: true });
});

// Частичное обновление: роль и/или новый пароль. Показать существующий
// пароль нельзя в принципе — в базе хранится только его bcrypt-хеш.
router.patch("/:username", (req, res) => {
  const { username } = req.params;
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!user) return res.status(404).json({ error: "not_found" });
  const { password, role } = req.body || {};
  if (role !== undefined) {
    if (!ROLES.has(role)) return res.status(400).json({ error: "invalid_role" });
    db.prepare("UPDATE users SET role = ? WHERE username = ?").run(role, username);
    logAudit({ actor: req.user.username, action: "user.role_change", entityType: "user", entityId: username, entityLabel: username, details: { role }, ip: req.ip });
  }
  if (password !== undefined) {
    if (!password || password.length < 4) return res.status(400).json({ error: "weak_password" });
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, username);
    logAudit({ actor: req.user.username, action: "user.password_reset", entityType: "user", entityId: username, entityLabel: username, ip: req.ip });
  }
  res.json({ ok: true });
});

router.delete("/:username", (req, res) => {
  const { username } = req.params;
  if (req.user.username === username) {
    return res.status(400).json({ error: "cannot_delete_self" });
  }
  const result = db.prepare("DELETE FROM users WHERE username = ?").run(username);
  if (result.changes === 0) return res.status(404).json({ error: "not_found" });
  logAudit({ actor: req.user.username, action: "user.delete", entityType: "user", entityId: username, entityLabel: username, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
