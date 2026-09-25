/*
E2E: значок формы на схеме связей (equipment_shapes.diagram_shape, настройка
"дай своё видение" — IILB/ISIB/MAP рисуются прямоугольником, ODF/MBU кругом,
MLA шестиугольником, настраивается в Настройки → Справочники → Формы
оборудования) и чекбокс "инфо на узлах" (показывает расположение/IP под
подписью узла, по умолчанию скрыто).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

test("схема: значок формы (rect/circle/hexagon) и переключатель 'инфо на узлах'", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-shapes", role: "engineer" });
  createProject(server.db, { id: "e2e-shapes", name: "E2E node shapes" });
  seedSnapshot(server.db, "e2e-shapes", {
    equipment: [
      { id: "eqMap", label: "МАП-1", shape: "map", position: [0, 0, 0], size: 5, location: "Гор. -120, ПК3", ip: "10.0.0.5" },
      { id: "eqOdf", label: "ODF-1", shape: "odf", position: [20, 0, 0], size: 5 },
      { id: "eqMla", label: "MLA-1", shape: "mla", position: [40, 0, 0], size: 5 },
    ],
    cables: [
      { id: "c1", label: "Трасса-1", cableType: "vols", nodes: [[0, 0, 0], [20, 0, 0]], endpointAEquipId: "eqMap", endpointBEquipId: "eqOdf" },
      { id: "c2", label: "Трасса-2", cableType: "vols", nodes: [[20, 0, 0], [40, 0, 0]], endpointAEquipId: "eqOdf", endpointBEquipId: "eqMla" },
    ],
  });

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(server.baseUrl + "/");
  await page.evaluate(
    (session) => localStorage.setItem("kzmAuthSession", JSON.stringify(session)),
    { token: tokenFor(engineer), username: engineer.username, role: engineer.role }
  );
  await page.goto(`${server.baseUrl}/e2e-shapes/schema`);
  await page.waitForLoadState("networkidle");
  await page.waitForSelector('#viewport g[data-equip-id="eqMap"]', { timeout: 8000 });

  await t.test("MAP — прямоугольник (rect), не круг", async () => {
    const tag = await page.locator('#viewport g[data-equip-id="eqMap"] .node-circle').evaluate((el) => el.tagName.toLowerCase());
    assert.equal(tag, "rect");
  });

  await t.test("ODF — круг (не изменился, дефолт)", async () => {
    const tag = await page.locator('#viewport g[data-equip-id="eqOdf"] .node-circle').evaluate((el) => el.tagName.toLowerCase());
    assert.equal(tag, "circle");
  });

  await t.test("MLA — шестиугольник (polygon)", async () => {
    const tag = await page.locator('#viewport g[data-equip-id="eqMla"] .node-circle').evaluate((el) => el.tagName.toLowerCase());
    assert.equal(tag, "polygon");
    const points = await page.locator('#viewport g[data-equip-id="eqMla"] .node-circle').getAttribute("points");
    const vertexCount = points.trim().split(/\s+/).length;
    assert.equal(vertexCount, 6);
  });

  await t.test("клик по прямоугольному узлу (MAP) всё равно открывает панель Инфо", async () => {
    await page.click('#viewport g[data-equip-id="eqMap"] .node-circle');
    await page.waitForSelector("#infoPanel[open]", { timeout: 4000 });
    const title = await page.locator("#infoPanel .ip-title").textContent();
    assert.equal(title, "МАП-1");
  });

  await t.test("по умолчанию — расположение/IP под узлом скрыты", async () => {
    const visible = await page.locator('#viewport g[data-equip-id="eqMap"] .node-extra-info').first().isVisible();
    assert.equal(visible, false);
  });

  await t.test("галочка 'инфо на узлах' показывает расположение и IP", async () => {
    await page.check("#chkShowNodeInfo");
    await page.waitForSelector('#viewport g[data-equip-id="eqMap"] .node-extra-info', { state: "visible", timeout: 4000 });
    const lines = await page.locator('#viewport g[data-equip-id="eqMap"] .node-extra-info').allTextContents();
    assert.deepEqual(lines, ["Гор. -120, ПК3", "10.0.0.5"]);
  });

  await t.test("узел без location/ip не показывает пустых строк инфо", async () => {
    const count = await page.locator('#viewport g[data-equip-id="eqOdf"] .node-extra-info').count();
    assert.equal(count, 0);
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});
