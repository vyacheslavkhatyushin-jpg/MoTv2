const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser } = require("../../testHelpers/seed");

test("POST /api/auth/login", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  createUser(server.db, { username: "alice", password: "S3cure-Pass!", role: "engineer" });

  await t.test("верный логин/пароль — 200 + токен + роль", async () => {
    const resp = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "S3cure-Pass!" }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.username, "alice");
    assert.equal(body.role, "engineer");
    assert.ok(body.token && body.token.split(".").length === 3, "похоже на JWT");
  });

  await t.test("неверный пароль — 401, не 200", async () => {
    const resp = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong" }),
    });
    assert.equal(resp.status, 401);
  });

  await t.test("несуществующий пользователь — 401 (не 404, чтобы не палить существование логина)", async () => {
    const resp = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "no-such-user", password: "whatever" }),
    });
    assert.equal(resp.status, 401);
  });

  await t.test("без пароля — 400", async () => {
    const resp = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    assert.equal(resp.status, 400);
  });
});

test("requireAuth: защищённый роут без токена — 401", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const resp = await fetch(`${server.baseUrl}/api/projects`);
  assert.equal(resp.status, 401);
});

test("requireAuth: защищённый роут с мусорным токеном — 401", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const resp = await fetch(`${server.baseUrl}/api/projects`, {
    headers: { Authorization: "Bearer not-a-real-jwt" },
  });
  assert.equal(resp.status, 401);
});
