/*
Отметка Z поверхности проекта (projects.surface_level) — плоскость-подложка
в редакторе для расстановки поверхностного оборудования, задаётся в
Настройки → Пороги (см. обсуждение в этой сессии: макет + план). Значение
приходит вместе с GET /:id/state (project.surfaceLevel), правится отдельным
PUT /:id/surface-level.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, authHeader } = require("../../testHelpers/seed");

test("отметка поверхности проекта (surface-level)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const viewer = createUser(server.db, { username: "surf-viewer", role: "viewer" });
  const engineer = createUser(server.db, { username: "surf-engineer", role: "engineer" });
  createProject(server.db, { id: "surf-proj", name: "x" });

  await t.test("по умолчанию — null (не настроено)", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/surf-proj/state`, { headers: authHeader(viewer) });
    const body = await resp.json();
    assert.equal(body.project.surfaceLevel, null);
  });

  await t.test("viewer не может задать отметку — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/surf-proj/surface-level`, {
      method: "PUT", headers: { ...authHeader(viewer), "Content-Type": "application/json" },
      body: JSON.stringify({ surfaceLevel: 245 }),
    });
    assert.equal(resp.status, 403);
  });

  await t.test("engineer задаёт отметку — сохраняется и видна в /state", async () => {
    const putResp = await fetch(`${server.baseUrl}/api/projects/surf-proj/surface-level`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ surfaceLevel: 245.5 }),
    });
    assert.equal(putResp.status, 200);
    const stateResp = await fetch(`${server.baseUrl}/api/projects/surf-proj/state`, { headers: authHeader(engineer) });
    const body = await stateResp.json();
    assert.equal(body.project.surfaceLevel, 245.5);
  });

  await t.test("engineer сбрасывает отметку обратно на null", async () => {
    const putResp = await fetch(`${server.baseUrl}/api/projects/surf-proj/surface-level`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ surfaceLevel: null }),
    });
    assert.equal(putResp.status, 200);
    const stateResp = await fetch(`${server.baseUrl}/api/projects/surf-proj/state`, { headers: authHeader(engineer) });
    const body = await stateResp.json();
    assert.equal(body.project.surfaceLevel, null);
  });

  await t.test("нечисловое значение — 400", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/surf-proj/surface-level`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ surfaceLevel: "245" }),
    });
    assert.equal(resp.status, 400);
  });

  await t.test("несуществующий проект — 404", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/no-such-project/surface-level`, {
      method: "PUT", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ surfaceLevel: 100 }),
    });
    assert.equal(resp.status, 404);
  });
});
