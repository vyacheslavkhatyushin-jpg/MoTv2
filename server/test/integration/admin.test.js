/*
Регрессия на баг этой сессии: apiFetch() на фронте (settings.html)
глобально трактует любой HTTP 401 как "сессия истекла" и разлогинивает.
Эндпоинты routes/admin.js, где 401 может значить "неверный пароль
подтверждения" (а не протухший токен), обязаны отвечать 403, никогда 401,
на неверный пароль — иначе пользователя молча выкидывает из сессии на
попытке подтвердить удаление. Тесты ниже проверяют именно это, плюс
обычную ролевую защиту (весь /api/admin — только role="admin").
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, authHeader } = require("../../testHelpers/seed");

test("/api/admin: доступ только для role=admin", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const engineer = createUser(server.db, { username: "eng", role: "engineer" });
  const supervisor = createUser(server.db, { username: "sup", role: "supervisor" });
  const admin = createUser(server.db, { username: "adm", role: "admin" });

  await t.test("engineer — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/admin/projects`, { headers: authHeader(engineer) });
    assert.equal(resp.status, 403);
  });
  await t.test("supervisor — 403 (тоже не admin)", async () => {
    const resp = await fetch(`${server.baseUrl}/api/admin/projects`, { headers: authHeader(supervisor) });
    assert.equal(resp.status, 403);
  });
  await t.test("admin — 200", async () => {
    const resp = await fetch(`${server.baseUrl}/api/admin/projects`, { headers: authHeader(admin) });
    assert.equal(resp.status, 200);
  });
});

test("model/delete-by-type: неверный пароль — 403 (НЕ 401), ничего не удаляет", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const admin = createUser(server.db, { username: "adm2", password: "Real-Pass-1", role: "admin" });
  createProject(server.db, { id: "proj-del", name: "x" });
  server.db
    .prepare(`INSERT INTO project_state (project_id, snapshot_json, version) VALUES (?, ?, 1)`)
    .run("proj-del", JSON.stringify({ cables: [{ id: "c1", cableType: "power" }], equipment: [], marks: [], patches: [] }));

  const resp = await fetch(`${server.baseUrl}/api/admin/projects/proj-del/model/delete-by-type`, {
    method: "POST",
    headers: { ...authHeader(admin), "Content-Type": "application/json" },
    body: JSON.stringify({ password: "totally-wrong", cableTypes: ["power"] }),
  });
  assert.equal(resp.status, 403, "неверный пароль подтверждения должен быть 403, а не 401 (иначе фронт разлогинит)");

  const snap = server.db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get("proj-del");
  const parsed = JSON.parse(snap.snapshot_json);
  assert.equal(parsed.cables.length, 1, "ничего не должно было удалиться при неверном пароле");
});

test("model/delete-by-type: верный пароль — 200, удаляет только выбранный тип", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const admin = createUser(server.db, { username: "adm3", password: "Real-Pass-2", role: "admin" });
  createProject(server.db, { id: "proj-del2", name: "x" });
  server.db.prepare(`INSERT INTO project_state (project_id, snapshot_json, version) VALUES (?, ?, 1)`).run(
    "proj-del2",
    JSON.stringify({
      cables: [{ id: "c1", cableType: "power" }, { id: "c2", cableType: "fiber" }],
      equipment: [], marks: [], patches: [],
    })
  );

  const resp = await fetch(`${server.baseUrl}/api/admin/projects/proj-del2/model/delete-by-type`, {
    method: "POST",
    headers: { ...authHeader(admin), "Content-Type": "application/json" },
    body: JSON.stringify({ password: "Real-Pass-2", cableTypes: ["power"] }),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.removedCables, 1);

  const snap = server.db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get("proj-del2");
  const parsed = JSON.parse(snap.snapshot_json);
  assert.deepEqual(parsed.cables.map((c) => c.cableType), ["fiber"]);
});

test("monitoring/clear: неверный пароль — 403 (та же регрессия)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const admin = createUser(server.db, { username: "adm4", password: "Real-Pass-3", role: "admin" });
  createProject(server.db, { id: "proj-mon", name: "x" });

  const resp = await fetch(`${server.baseUrl}/api/admin/projects/proj-mon/monitoring/clear`, {
    method: "POST",
    headers: { ...authHeader(admin), "Content-Type": "application/json" },
    body: JSON.stringify({ password: "nope" }),
  });
  assert.equal(resp.status, 403);
});
