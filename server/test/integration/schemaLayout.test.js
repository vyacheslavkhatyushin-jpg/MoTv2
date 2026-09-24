/*
Ручная раскладка схемы связей (Фаза 4, см. public/schema.html и
schema_layout_overrides в db.js) — координаты узла, которые пользователь
перетащил мышью, сохраняются на сервере и переопределяют force-directed
раскладку при следующей отрисовке. Правка (PUT/DELETE) — как редактирование
модели (engineer/supervisor/admin), чтение — любая авторизованная роль (как
и сама схема).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, authHeader } = require("../../testHelpers/seed");

test("схема связей: ручная раскладка (schema-layout)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const viewer = createUser(server.db, { username: "layout-viewer", role: "viewer" });
  const engineer = createUser(server.db, { username: "layout-engineer", role: "engineer" });
  createProject(server.db, { id: "layout-proj", name: "x" });

  await t.test("изначально позиций нет", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, { headers: authHeader(engineer) });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.positions, {});
  });

  await t.test("viewer не может закрепить узел — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqA`, {
      method: "PUT", headers: { ...authHeader(viewer), "Content-Type": "application/json" },
      body: JSON.stringify({ x: 10, y: 20 }),
    });
    assert.equal(resp.status, 403);
  });

  await t.test("нечисловые координаты — 400", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqA`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ x: "abc", y: 20 }),
    });
    assert.equal(resp.status, 400);
  });

  await t.test("engineer закрепляет узел — 200, координаты сохранены", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqA`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ x: 12.5, y: -7 }),
    });
    assert.equal(resp.status, 200);
    const getResp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, { headers: authHeader(engineer) });
    const body = await getResp.json();
    assert.deepEqual(body.positions, { eqA: { x: 12.5, y: -7 } });
  });

  await t.test("повторный PUT того же узла — перезаписывает координаты (upsert)", async () => {
    await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqA`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ x: 99, y: 1 }),
    });
    const getResp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, { headers: authHeader(engineer) });
    const body = await getResp.json();
    assert.deepEqual(body.positions.eqA, { x: 99, y: 1 });
  });

  await t.test("второй узел — обе позиции сосуществуют", async () => {
    await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqB`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ x: 5, y: 5 }),
    });
    const getResp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, { headers: authHeader(engineer) });
    const body = await getResp.json();
    assert.equal(Object.keys(body.positions).length, 2);
  });

  await t.test("viewer не может открепить узел — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqA`, {
      method: "DELETE", headers: authHeader(viewer),
    });
    assert.equal(resp.status, 403);
  });

  await t.test("engineer открепляет один узел — остаётся только второй", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout/eqA`, {
      method: "DELETE", headers: authHeader(engineer),
    });
    assert.equal(resp.status, 200);
    const getResp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, { headers: authHeader(engineer) });
    const body = await getResp.json();
    assert.deepEqual(Object.keys(body.positions), ["eqB"]);
  });

  await t.test("viewer не может сбросить всю раскладку — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, {
      method: "DELETE", headers: authHeader(viewer),
    });
    assert.equal(resp.status, 403);
  });

  await t.test("engineer сбрасывает всю раскладку — позиций не осталось", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, {
      method: "DELETE", headers: authHeader(engineer),
    });
    assert.equal(resp.status, 200);
    const getResp = await fetch(`${server.baseUrl}/api/projects/layout-proj/schema-layout`, { headers: authHeader(engineer) });
    const body = await getResp.json();
    assert.deepEqual(body.positions, {});
  });

  await t.test("несуществующий проект — 404", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/no-such-project/schema-layout`, { headers: authHeader(engineer) });
    assert.equal(resp.status, 404);
  });
});
