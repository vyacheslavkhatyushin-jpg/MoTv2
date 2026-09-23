/*
Общие хелперы сидинга для интеграционных тестов — прямые INSERT'ы в БД
(быстрее и не зависят от тестируемых роутов), плюс выдача JWT напрямую,
без похода через /api/auth/login, когда сам логин не является предметом
теста.
*/
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { TEST_JWT_SECRET } = require("./spawnServer");

function createUser(db, { username, password = "TestPass123!", role = "viewer" }) {
  const hash = bcrypt.hashSync(password, 4); // низкий cost — тесты, не прод
  const info = db
    .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
    .run(username, hash, role);
  return { id: info.lastInsertRowid, username, password, role };
}

function createProject(db, { id, name }) {
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
  return { id, name };
}

function seedSnapshot(db, projectId, { cables = [], equipment = [], marks = [], patches = [] } = {}) {
  db.prepare(
    `INSERT INTO project_state (project_id, snapshot_json, version) VALUES (?, ?, 1)
     ON CONFLICT(project_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`
  ).run(projectId, JSON.stringify({ cables, equipment, marks, patches }));
}

// eq.position обязателен — restoreFromSnapshot() на клиенте (public/index.html)
// падает на new THREE.Vector3(eq.position[0], ...) без него; наступили на
// это в сессии, когда тестировали статус-бар без position в сидинге.
function seedMonitorStatus(db, projectId, equipmentId, { state = "up", personCount = null, vehicleCount = null, lastChangeAt = null } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at, last_change_at, person_count, vehicle_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, equipmentId, state, now, lastChangeAt || now, personCount, vehicleCount);
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

function authHeader(user) {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}

module.exports = { createUser, createProject, seedSnapshot, seedMonitorStatus, tokenFor, authHeader };
