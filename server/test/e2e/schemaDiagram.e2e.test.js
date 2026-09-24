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

test("страница Схема: перетаскивание узла закрепляет позицию, сброс возвращает автораскладку (Фаза 4)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-schema-drag", role: "engineer" });
  const viewer = createUser(server.db, { username: "e2e-schema-drag-viewer", role: "viewer" });
  createProject(server.db, { id: "e2e-schema-drag", name: "E2E schema drag" });
  seedSnapshot(server.db, "e2e-schema-drag", {
    equipment: [
      { id: "eqA", label: "МАП-А", shape: "map", position: [0, 0, 0], size: 5 },
      { id: "eqB", label: "МАП-Б", shape: "map", position: [50, 0, 0], size: 5 },
    ],
    cables: [{ id: "cab1", label: "Трасса-1", cableType: "vols", nodes: [[0, 0, 0], [50, 0, 0]], endpointAEquipId: "eqA", endpointBEquipId: "eqB" }],
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
  await page.goto(`${server.baseUrl}/e2e-schema-drag/schema`);
  await page.waitForLoadState("networkidle");
  await page.waitForSelector('#viewport g[data-equip-id="eqA"]', { timeout: 8000 });

  await t.test("узел без ручной раскладки — сплошная обводка (не закреплён)", async () => {
    const dash = await page.locator('#viewport g[data-equip-id="eqA"] circle').getAttribute("stroke-dasharray");
    assert.equal(dash, null);
  });

  await t.test("перетаскивание узла — обводка становится пунктирной, координаты сохранены на сервере", async () => {
    const g = page.locator('#viewport g[data-equip-id="eqA"]');
    const box = await g.locator("circle").boundingBox();
    const startX = box.x + box.width / 2, startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY + 60, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      () => document.querySelector('#viewport g[data-equip-id="eqA"] circle')?.getAttribute("stroke-dasharray") === "3 2",
      { timeout: 4000 }
    );

    // Позиция реально дошла до сервера — не только визуальный эффект в DOM.
    const resp = await page.request.get(`${server.baseUrl}/api/projects/e2e-schema-drag/schema-layout`, {
      headers: { Authorization: `Bearer ${tokenFor(engineer)}` },
    });
    const body = await resp.json();
    assert.ok(body.positions.eqA, "позиция eqA должна быть сохранена на сервере");
  });

  await t.test("перезагрузка страницы — узел остаётся закреплённым (пунктирная обводка)", async () => {
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector('#viewport g[data-equip-id="eqA"]', { timeout: 8000 });
    const dash = await page.locator('#viewport g[data-equip-id="eqA"] circle').getAttribute("stroke-dasharray");
    assert.equal(dash, "3 2");
  });

  await t.test("двойной клик по закреплённому узлу — открепляет (обводка снова сплошная)", async () => {
    await page.dblclick('#viewport g[data-equip-id="eqA"] circle');
    await page.waitForFunction(
      () => document.querySelector('#viewport g[data-equip-id="eqA"] circle')?.getAttribute("stroke-dasharray") === null,
      { timeout: 4000 }
    );
  });

  await t.test("viewer не видит кнопку 'Сбросить раскладку' и не может тащить узлы", async () => {
    await page.evaluate(
      (session) => localStorage.setItem("kzmAuthSession", JSON.stringify(session)),
      { token: tokenFor(viewer), username: viewer.username, role: viewer.role }
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector('#viewport g[data-equip-id="eqA"]', { timeout: 8000 });
    await page.waitForSelector("#btnResetLayout", { state: "hidden", timeout: 4000 });
    const hasEditableClass = await page.locator("#diagramWrap").evaluate((el) => el.classList.contains("editable"));
    assert.equal(hasEditableClass, false);
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
