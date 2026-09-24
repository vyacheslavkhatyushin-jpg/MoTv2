/*
E2E: страница "Схема" (/<project>/schema) — Фаза 2/3 плана "структурная схема
связей" (см. обсуждение в этой сессии и Фазу 1: endpointAEquipId/
endpointBEquipId на кабеле в редакторе). Строит граф на клиенте из
/api/projects/:id/state (узлы — оборудование, рёбра — кабели с ОБОИМИ
указанными концами) и раскладывает его force-directed layout'ом; кабели
только с одним концом и несвязанное оборудование не попадают на схему, а
перечисляются в боковых списках — это то, что тест ниже и проверяет.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

test("страница Схема: рисует связанные кабелем объекты, отдельно перечисляет несвязанные/недосвязанные", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-schema", role: "engineer" });
  createProject(server.db, { id: "e2e-schema", name: "E2E schema" });
  seedSnapshot(server.db, "e2e-schema", {
    equipment: [
      { id: "eqA", label: "МАП-А", shape: "map", position: [0, 0, 0], size: 5 },
      { id: "eqB", label: "МАП-Б", shape: "map", position: [50, 0, 0], size: 5 },
      { id: "eqC", label: "Изолят-В", shape: "wifi", position: [100, 0, 0], size: 5 },
    ],
    cables: [
      { id: "cab1", label: "Трасса-связанная", cableType: "vols", nodes: [[0, 0, 0], [50, 0, 0]], endpointAEquipId: "eqA", endpointBEquipId: "eqB" },
      { id: "cab2", label: "Трасса-недосвязанная", cableType: "vols", nodes: [[0, 0, 0], [10, 0, 0]], endpointAEquipId: "eqA", endpointBEquipId: "" },
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
  await page.goto(`${server.baseUrl}/e2e-schema/schema`);
  await page.waitForLoadState("networkidle");

  await t.test("связанные кабелем eqA/eqB нарисованы как узлы схемы", async () => {
    await page.waitForSelector('#viewport g[data-equip-id="eqA"]', { timeout: 8000 });
    await page.waitForSelector('#viewport g[data-equip-id="eqB"]', { timeout: 4000 });
    const edgeCount = await page.locator("#viewport .edge-line").count();
    assert.equal(edgeCount, 1, "ровно одно ребро — кабель с обоими концами");
  });

  await t.test("изолированное оборудование (без кабеля) — в списке 'без связей', не на схеме", async () => {
    const onCanvas = await page.locator('#viewport g[data-equip-id="eqC"]').count();
    assert.equal(onCanvas, 0);
    const text = await page.locator("#listUnlinked").innerText();
    assert.match(text, /Изолят-В/);
  });

  await t.test("кабель с одним концом — в списке 'неполная привязка', не рисуется ребром", async () => {
    // Секция "Кабели с неполной привязкой" свёрнута по умолчанию (<details>
    // без open) — innerText() уважает CSS-видимость и вернул бы "" для
    // скрытого содержимого, поэтому здесь textContent() (данные уже в DOM,
    // просто не показаны, пока пользователь не раскроет секцию).
    const text = await page.locator("#listPartial").textContent();
    assert.match(text, /Трасса-недосвязанная/);
  });

  await t.test("клик по узлу открывает панель Инфо со статусом и ссылкой в редактор", async () => {
    await page.click('#viewport g[data-equip-id="eqA"] circle');
    await page.waitForSelector("#infoPanel[open]", { timeout: 4000 });
    const title = await page.locator("#infoPanel .ip-title").innerText();
    assert.equal(title, "МАП-А");
    const href = await page.locator("#infoPanel .ip-open").getAttribute("href");
    assert.equal(href, "/e2e-schema?equip=eqA");
  });

  await t.test("фильтр по системе ВОЛС оставляет ту же пару (MAP входит в ВОЛС)", async () => {
    await page.click('.sys-btn:has-text("ВОЛС")');
    await page.waitForSelector('#viewport g[data-equip-id="eqA"]', { timeout: 4000 });
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});

test("страница Схема: пустой проект без связей показывает подсказку, не падает", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-schema-empty", role: "engineer" });
  createProject(server.db, { id: "e2e-schema-empty", name: "E2E schema empty" });
  seedSnapshot(server.db, "e2e-schema-empty", {
    equipment: [{ id: "eqOnly", label: "Одиночный", shape: "map", position: [0, 0, 0], size: 5 }],
    cables: [],
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
  await page.goto(`${server.baseUrl}/e2e-schema-empty/schema`);
  await page.waitForLoadState("networkidle");

  await t.test("подсказка про отсутствие связей видна", async () => {
    await page.waitForSelector("#emptyHint", { state: "visible", timeout: 8000 });
    const text = await page.locator("#emptyHint").innerText();
    assert.match(text, /Связей пока не задано/);
  });

  await t.test("одиночное оборудование — в списке без связей", async () => {
    const text = await page.locator("#listUnlinked").innerText();
    assert.match(text, /Одиночный/);
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});
