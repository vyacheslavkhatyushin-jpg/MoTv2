/*
Профили оборудования + профиль формы по умолчанию (детектор "должно быть,
но не пришло" в карточке "Инфо", см. server/routes/references.js).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, authHeader } = require("../../testHelpers/seed");

test("GET /equipment-profiles/public: доступен любой роли, отдаёт профили с атрибутами + shapeDefaults из сида", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const viewer = createUser(server.db, { username: "prof-viewer", role: "viewer" });

  const resp = await fetch(`${server.baseUrl}/api/references/equipment-profiles/public`, { headers: authHeader(viewer) });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const iilb = body.profiles.find((p) => p.id === "p-iilb");
  assert.ok(iilb, "профиль IILB из сида должен присутствовать");
  assert.ok(iilb.attributes.some((a) => a.key === "personCount"));
  assert.equal(body.shapeDefaults.iilb, "p-iilb", "сид уже назначает IILB-форме профиль p-iilb по умолчанию");
});

test("shape-default-profiles: CRUD только для admin", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const viewer = createUser(server.db, { username: "sdp-viewer", role: "viewer" });
  const admin = createUser(server.db, { username: "sdp-admin", role: "admin" });

  await t.test("viewer — 403 и на GET, и на PUT", async () => {
    const getResp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles`, { headers: authHeader(viewer) });
    assert.equal(getResp.status, 403);
    const putResp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles/map`, {
      method: "PUT", headers: { ...authHeader(viewer), "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "p-iilb" }),
    });
    assert.equal(putResp.status, 403);
  });

  await t.test("admin: назначить профиль форме, увидеть в GET", async () => {
    const putResp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles/map`, {
      method: "PUT", headers: { ...authHeader(admin), "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "p-iilb" }),
    });
    assert.equal(putResp.status, 200);
    const getResp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles`, { headers: authHeader(admin) });
    const body = await getResp.json();
    assert.ok(body.shapeDefaults.some((r) => r.shape === "map" && r.profileId === "p-iilb"));
  });

  await t.test("admin: снять профиль формы (profileId: null)", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles/map`, {
      method: "PUT", headers: { ...authHeader(admin), "Content-Type": "application/json" }, body: JSON.stringify({ profileId: null }),
    });
    assert.equal(resp.status, 200);
    const getResp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles`, { headers: authHeader(admin) });
    const body = await getResp.json();
    assert.ok(!body.shapeDefaults.some((r) => r.shape === "map"));
  });

  await t.test("неизвестная форма — 404", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles/no-such-shape`, {
      method: "PUT", headers: { ...authHeader(admin), "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "p-iilb" }),
    });
    assert.equal(resp.status, 404);
  });

  await t.test("неизвестный профиль — 400", async () => {
    const resp = await fetch(`${server.baseUrl}/api/references/shape-default-profiles/map`, {
      method: "PUT", headers: { ...authHeader(admin), "Content-Type": "application/json" }, body: JSON.stringify({ profileId: "no-such-profile" }),
    });
    assert.equal(resp.status, 400);
  });
});
