/*
E2E: клик по объекту прямо на 3D-модели (оборудование/кабель/метка) открывает
панель "Инфо" — раньше это работало только через список справа
(showQuickInfoEquip и т.п. вызывались из buildEquipList()/buildCableList());
клик по самому мешу в сцене ничего не делал, потому что raycaster в
обработчике клика (renderer.domElement) обходил только modelGroup (геометрию
шахты), а оборудование/кабели/метки добавляются прямо в scene — см.
getUserObjectMeshes()/findUserObjectFromMesh() в index.html.

Playwright не умеет "кликнуть по объекту", только по пиксельным координатам
канваса — поэтому тест использует window.__mot3dWorldToScreen(x,y,z), тестовый
хук (только проекция мировых координат через THREE.Vector3.project(camera),
ничего не мутирует), чтобы перевести известную мировую позицию оборудования
в экранные координаты для настоящего мышиного клика.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

// Тестовые снапшоты сеются напрямую в БД (seedSnapshot), минуя обычный путь
// "загрузили .str → раскладываем оборудование по его поверхности" — модель
// шахты в этих сценариях никогда не загружается. В реальном использовании
// это не проблема (оборудование физически негде разместить без модели,
// клик в drawMode="equip" сам требует хита по её геометрии), но оверлей
// "Модель не загружена" (#empty, position:absolute; inset:0) в таком тесте
// перекрывает канвас и глотает клик ещё до раycaster'а — прячем его вручную.
async function hideEmptyModelOverlay(page) {
  await page.evaluate(() => {
    const el = document.getElementById("empty");
    if (el) el.style.display = "none";
  });
}
async function clickWorldPoint(page, x, y, z) {
  const screen = await page.evaluate(
    ([wx, wy, wz]) => window.__mot3dWorldToScreen(wx, wy, wz),
    [x, y, z]
  );
  await page.mouse.click(screen.x, screen.y);
}

test("клик по 3D-объекту открывает панель Инфо (оборудование/кабель/метка)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-click3d", role: "engineer" });
  createProject(server.db, { id: "e2e-click3d", name: "E2E click3d" });
  seedSnapshot(server.db, "e2e-click3d", {
    equipment: [{ id: "eqA", label: "МАП-тестовый", shape: "map", position: [0, 0, 0], size: 20 }],
    cables: [{ id: "cab1", label: "Трасса-тестовая", cableType: "vols", nodes: [[-80, 0, 0], [-40, 0, 0]] }],
    marks: [{ id: "mark1", label: "Метка-тестовая", markType: "danger", position: [80, 0, 0] }],
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
  await page.goto(`${server.baseUrl}/e2e-click3d`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.__mot3dWorldToScreen === "function", { timeout: 8000 });
  await hideEmptyModelOverlay(page);

  await t.test("клик по оборудованию на модели показывает его карточку", async () => {
    await clickWorldPoint(page, 0, 0, 0);
    await page.waitForFunction(
      () => document.querySelector("#quickInfoBody .qi-title")?.textContent === "МАП-тестовый",
      { timeout: 4000 }
    );
    assert.ok(!(await page.locator("#quickInfoPanel").evaluate((el) => el.classList.contains("collapsed"))));
  });

  await t.test("клик по кабелю на модели показывает его карточку", async () => {
    await clickWorldPoint(page, -60, 0, 0);
    await page.waitForFunction(
      () => document.querySelector("#quickInfoBody .qi-title")?.textContent === "Трасса-тестовая",
      { timeout: 4000 }
    );
  });

  await t.test("клик по метке на модели показывает её карточку", async () => {
    await clickWorldPoint(page, 80, 0, 0);
    await page.waitForFunction(
      () => document.querySelector("#quickInfoBody .qi-title")?.textContent === "Метка-тестовая",
      { timeout: 4000 }
    );
  });

  await t.test("клик по пустому месту не открывает и не закрывает панель", async () => {
    // Не через clickWorldPoint/project() — точка позади камеры (мировые
    // координаты дальше камеры от цели обзора) проецируется в непредсказуемые
    // экранные координаты. Угол канваса гарантированно пуст без лишней математики.
    const rect = await page.locator("#glcanvas").boundingBox();
    await page.mouse.click(rect.x + 8, rect.y + 8);
    await page.waitForTimeout(200);
    const title = await page.locator("#quickInfoBody .qi-title").textContent();
    assert.equal(title, "Метка-тестовая", "последняя открытая карточка должна остаться как есть");
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});

test("клик по 3D-объекту во время рисования кабеля не открывает панель Инфо (ставит узел трассы)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-click3d-draw", role: "engineer" });
  createProject(server.db, { id: "e2e-click3d-draw", name: "E2E click3d draw" });
  seedSnapshot(server.db, "e2e-click3d-draw", {
    equipment: [{ id: "eqA", label: "МАП-тестовый", shape: "map", position: [0, 0, 0], size: 20 }],
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
  await page.goto(`${server.baseUrl}/e2e-click3d-draw`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.__mot3dWorldToScreen === "function", { timeout: 8000 });
  await hideEmptyModelOverlay(page);

  // Клик по оборудованию в режиме "рисуем кабель" не должен открыть панель
  // Инфо — курсор занят добавлением узла трассы, а не разглядыванием
  // объектов (см. `if (!drawMode && !pivotPickMode)` в обработчике клика).
  // Сам узел при этом не ставится (нет геометрии модели, чтобы найти точку
  // на её поверхности) — этой части теста не касаемся, важно только то,
  // что панель Инфо не открылась.
  await page.click('.tab-btn[data-tab="cables"]');
  await page.click("#btnAddCable");
  await clickWorldPoint(page, 0, 0, 0);
  await page.waitForTimeout(200);
  const collapsed = await page.locator("#quickInfoPanel").evaluate((el) => el.classList.contains("collapsed"));
  assert.equal(collapsed, true, "в режиме рисования кабеля клик по оборудованию не должен открывать панель Инфо");
});
