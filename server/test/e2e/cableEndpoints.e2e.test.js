/*
E2E: связность кабель↔оборудование (Фаза 1 плана "структурная схема связей",
см. обсуждение в этой сессии) — карточка кабеля получает два выпадающих
списка "Подключён (начало/конец)" с оборудованием проекта; выбор
сохраняется в снапшот и переживает перезагрузку страницы, как и любое
другое поле кабеля.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

async function openCableEditor(page) {
  await page.click('.tab-btn[data-tab="cables"]');
  const header = page.locator("#cableList .uo-group-header").first();
  await header.waitFor({ timeout: 8000 });
  // Группа свёрнута по умолчанию только один раз за сессию страницы —
  // при повторном вызове (например, после возврата с другой вкладки) она
  // уже развёрнута, и безусловный клик её бы обратно свернул.
  const isOpen = (await header.getAttribute("class") || "").includes("uo-group-open");
  if (!isOpen) await header.click();
  await page.waitForSelector("#cableList .uo-row", { timeout: 4000 });
  await page.click('#cableList .uo-row button[title="Редактировать"]');
  await page.waitForSelector("#cableDetails.open", { timeout: 4000 });
}

test("карточка кабеля: связность с оборудованием сохраняется и переживает перезагрузку", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-cable-ep", role: "engineer" });
  createProject(server.db, { id: "e2e-cable-ep", name: "E2E cable endpoints" });
  seedSnapshot(server.db, "e2e-cable-ep", {
    equipment: [
      { id: "eqA", label: "МАП-А", shape: "map", position: [0, 0, 0], size: 5 },
      { id: "eqB", label: "МАП-Б", shape: "map", position: [50, 0, 0], size: 5 },
    ],
    cables: [{ id: "cab1", label: "Трасса-1", cableType: "vols", nodes: [[0, 0, 0], [50, 0, 0]] }],
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
  await page.goto(`${server.baseUrl}/e2e-cable-ep`);
  // networkidle, не фиксированный таймаут — первый запуск браузера в файле
  // тестов холодный (загрузка software-WebGL и т.п.) и может не уложиться
  // в произвольную паузу: поймали настоящий флейк на этом именно здесь.
  await page.waitForLoadState("networkidle");

  await openCableEditor(page);

  await t.test("по умолчанию — 'не указано' на обоих концах", async () => {
    assert.equal(await page.locator("#cableDEndpointA").inputValue(), "");
    assert.equal(await page.locator("#cableDEndpointB").inputValue(), "");
  });

  await page.selectOption("#cableDEndpointA", { label: "МАП-А" });
  await page.selectOption("#cableDEndpointB", { label: "МАП-Б" });

  await page.click("#btnSaveAll");
  await page.waitForFunction(
    () => document.querySelector("#saveStatus")?.textContent.includes("охранен"),
    { timeout: 8000 }
  );

  await page.reload();
  await page.waitForLoadState("networkidle");
  await openCableEditor(page);

  await t.test("после перезагрузки — выбранные концы сохранились", async () => {
    const aValue = await page.locator("#cableDEndpointA").inputValue();
    const bValue = await page.locator("#cableDEndpointB").inputValue();
    assert.equal(aValue, "eqA");
    assert.equal(bValue, "eqB");
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});

test("удаление оборудования отвязывает кабель от него (не оставляет призрачную ссылку)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-cable-ep2", role: "engineer" });
  createProject(server.db, { id: "e2e-cable-ep2", name: "E2E cable endpoints 2" });
  seedSnapshot(server.db, "e2e-cable-ep2", {
    equipment: [{ id: "eqA", label: "МАП-А", shape: "map", position: [0, 0, 0], size: 5 }],
    cables: [{ id: "cab1", label: "Трасса-1", cableType: "vols", nodes: [[0, 0, 0], [50, 0, 0]], endpointAEquipId: "eqA" }],
  });

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());

  await page.goto(server.baseUrl + "/");
  await page.evaluate(
    (session) => localStorage.setItem("kzmAuthSession", JSON.stringify(session)),
    { token: tokenFor(engineer), username: engineer.username, role: engineer.role }
  );
  await page.goto(`${server.baseUrl}/e2e-cable-ep2`);
  await page.waitForLoadState("networkidle");

  await openCableEditor(page);
  assert.equal(await page.locator("#cableDEndpointA").inputValue(), "eqA", "связь должна быть видна до удаления");

  await page.click('.tab-btn[data-tab="equip"]');
  await page.waitForSelector("#equipList .uo-group-header", { timeout: 8000 });
  await page.click("#equipList .uo-group-header");
  await page.waitForSelector("#equipList .uo-row", { timeout: 4000 });
  await page.click('#equipList .uo-row button[title="Редактировать"]');
  await page.waitForSelector("#equipDetails.open", { timeout: 4000 });
  await page.click("#equipDDelete");
  await page.waitForSelector("#equipDetails:not(.open)", { state: "attached", timeout: 4000 });

  await openCableEditor(page);
  await t.test("после удаления оборудования — связь снята, не указывает на удалённый id", async () => {
    assert.equal(await page.locator("#cableDEndpointA").inputValue(), "");
  });
});

test("карточка кабеля: список 'Подключён' фильтруется по системе кабеля", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-cable-ep3", role: "engineer" });
  createProject(server.db, { id: "e2e-cable-ep3", name: "E2E cable endpoints 3" });
  seedSnapshot(server.db, "e2e-cable-ep3", {
    equipment: [
      // iilb -> система LFC (см. сид equipment_shape_systems в db.js)
      { id: "eqLfc", label: "IILB-LFC", shape: "iilb", position: [0, 0, 0], size: 5 },
      // stativ_ao -> система АО, никак не пересекается с LFC-кабелем
      { id: "eqAo", label: "Статив-АО", shape: "stativ_ao", position: [10, 0, 0], size: 5 },
      // custom -> ни в одной системе не числится, поэтому не исключается нигде
      { id: "eqCustom", label: "Прочее-оборудование", shape: "custom", position: [20, 0, 0], size: 5 },
    ],
    cables: [
      { id: "cabLfc", label: "Трасса-LFC", cableType: "lfc", nodes: [[0, 0, 0], [10, 0, 0]] },
      // уже подключена к оборудованию АО ДО того, как тип кабеля стал LFC —
      // имитирует смену типа задним числом, связь не должна пропасть молча.
      { id: "cabStale", label: "Трасса-устаревшая", cableType: "lfc", nodes: [[0, 0, 0], [10, 0, 0]], endpointAEquipId: "eqAo" },
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
  await page.goto(`${server.baseUrl}/e2e-cable-ep3`);
  await page.waitForLoadState("networkidle");

  await page.click('.tab-btn[data-tab="cables"]');
  const header = page.locator("#cableList .uo-group-header").first();
  await header.waitFor({ timeout: 8000 });
  if (!(await header.getAttribute("class") || "").includes("uo-group-open")) await header.click();
  await page.waitForSelector("#cableList .uo-row", { timeout: 4000 });
  const rows = page.locator("#cableList .uo-row");

  await t.test("LFC-кабель: в списке — оборудование LFC и без системы, АО-объекта нет", async () => {
    await rows.filter({ hasText: "Трасса-LFC" }).locator('button[title="Редактировать"]').click();
    await page.waitForSelector("#cableDetails.open", { timeout: 4000 });
    const optionTexts = await page.locator("#cableDEndpointA option").allTextContents();
    assert.ok(optionTexts.some((t) => t.includes("IILB-LFC")), "LFC-оборудование должно быть в списке");
    assert.ok(optionTexts.some((t) => t.includes("Прочее-оборудование")), "оборудование без системы не должно исключаться");
    assert.ok(!optionTexts.some((t) => t.includes("Статив-АО")), "АО-оборудование не должно предлагаться для LFC-кабеля");
  });

  await t.test("уже подключённое 'вне системы' оборудование остаётся в списке с пометкой", async () => {
    await rows.filter({ hasText: "Трасса-устаревшая" }).locator('button[title="Редактировать"]').click();
    await page.waitForSelector("#cableDetails.open", { timeout: 4000 });
    assert.equal(await page.locator("#cableDEndpointA").inputValue(), "eqAo", "существующая связь не должна пропасть");
    const selectedText = await page.locator('#cableDEndpointA option[value="eqAo"]').innerText();
    assert.match(selectedText, /вне системы кабеля/);
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});
