/*
Значок формы на схеме связей (equipment_shapes.diagram_shape, см. обсуждение
"дай своё видение" в этой сессии — настраиваемый через Настройки →
Справочники → Формы оборудования, а не захардкоженный в public/schema.html).

Проверяется именно ДЕЛЬТА этой фичи (не весь CRUD форм оборудования, который
раньше тестами не был покрыт вообще): поле отдаётся в /public для схемы,
принимается и валидируется при создании/правке формы, дефолт "circle"
переживает БД-миграцию на уже существующих формах (см. отдельную проверку
миграции в db.js — тут только то, что видно через API на свежей БД).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, authHeader } = require("../../testHelpers/seed");

test("значок формы на схеме (diagramShape)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const admin = createUser(server.db, { username: "shape-admin", role: "admin" });
  const engineer = createUser(server.db, { username: "shape-engineer", role: "engineer" });

  await t.test("сид: IILB/ISIB/MAP — прямоугольник, ODF — круг, MLA — шестиугольник", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/public`, { headers: authHeader(engineer) });
    const body = await resp.json();
    const byKey = Object.fromEntries(body.shapes.map((s) => [s.key, s.diagramShape]));
    assert.equal(byKey.iilb, "rect");
    assert.equal(byKey.isib, "rect");
    assert.equal(byKey.map, "rect");
    assert.equal(byKey.odf, "circle");
    assert.equal(byKey.mla, "hexagon");
    // Формы, для которых пользователь не просил ничего менять, остаются
    // кругом — визуально не меняется поведение схемы для них.
    assert.equal(byKey.wifi, "circle");
  });

  await t.test("создание новой формы с diagramShape — сохраняется и отдаётся в /public", async () => {
    const createResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes`, {
      method: "POST", headers: { ...authHeader(admin), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test_shape_1", label: "Тестовая форма", diagramShape: "triangle" }),
    });
    assert.equal(createResp.status, 201);
    const pubResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/public`, { headers: authHeader(engineer) });
    const pubBody = await pubResp.json();
    const created = pubBody.shapes.find((s) => s.key === "test_shape_1");
    assert.equal(created.diagramShape, "triangle");
  });

  await t.test("создание без diagramShape — дефолт 'circle'", async () => {
    const createResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes`, {
      method: "POST", headers: { ...authHeader(admin), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test_shape_2", label: "Тестовая форма 2" }),
    });
    assert.equal(createResp.status, 201);
    const pubResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/public`, { headers: authHeader(engineer) });
    const pubBody = await pubResp.json();
    const created = pubBody.shapes.find((s) => s.key === "test_shape_2");
    assert.equal(created.diagramShape, "circle");
  });

  await t.test("невалидное значение diagramShape — 400 при создании", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/equipment-shapes`, {
      method: "POST", headers: { ...authHeader(admin), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test_shape_bad", label: "x", diagramShape: "star" }),
    });
    assert.equal(resp.status, 400);
  });

  await t.test("PATCH меняет diagramShape существующей формы", async () => {
    const patchResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/odf`, {
      method: "PATCH", headers: { ...authHeader(admin), "Content-Type": "application/json" },
      body: JSON.stringify({ diagramShape: "diamond" }),
    });
    assert.equal(patchResp.status, 200);
    const pubResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/public`, { headers: authHeader(engineer) });
    const pubBody = await pubResp.json();
    const odf = pubBody.shapes.find((s) => s.key === "odf");
    assert.equal(odf.diagramShape, "diamond");
  });

  await t.test("PATCH с невалидным diagramShape — 400, старое значение не тронуто", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/mla`, {
      method: "PATCH", headers: { ...authHeader(admin), "Content-Type": "application/json" },
      body: JSON.stringify({ diagramShape: "not_a_shape" }),
    });
    assert.equal(resp.status, 400);
    const pubResp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/public`, { headers: authHeader(engineer) });
    const pubBody = await pubResp.json();
    const mla = pubBody.shapes.find((s) => s.key === "mla");
    assert.equal(mla.diagramShape, "hexagon", "невалидный PATCH не должен был применяться");
  });

  await t.test("engineer не может менять справочник форм — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/equipment-shapes/odf`, {
      method: "PATCH", headers: { ...authHeader(engineer), "Content-Type": "application/json" },
      body: JSON.stringify({ diagramShape: "circle" }),
    });
    assert.equal(resp.status, 403);
  });
});
