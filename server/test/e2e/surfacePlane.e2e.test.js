/*
E2E: отметка поверхности проекта (projects.surface_level) — плоскость-подложка
в редакторе для расстановки оборудования, которое физически находится на
поверхности, а не в модели шахты (см. обсуждение в этой сессии: без реальной
топографии земли строить поверхность по самым высоким точкам тоннелей нельзя —
глубина до земли неизвестна и нигде не смоделирована; вместо этого — плоская
опорная плоскость на заданной отметке Z + возможность вручную задать
координаты оборудования).

Часть 1: чекбокс "Показать поверхность" в кладке Шахта скрыт, пока для
проекта не задана отметка (surfaceLevel), и появляется после того, как она
задана через PUT /api/projects/:id/surface-level.

Часть 2: включив чекбокс, можно кликнуть по самой плоскости в drawMode="equip"
и разместить оборудование — getIntersectableMeshes() отдаёт плоскость в
raycaster наравне с геометрией модели. Клик по мировой точке через
window.__mot3dWorldToScreen (см. click3dToInfo.e2e.test.js) — при
modelOffset = [0,0,0] (модель .str не загружается) realToScene([0,0,Z]) даёт
ровно (0, Z, 0) в сценовых координатах.

Часть 3: карточка оборудования — блок координат свёрнут по умолчанию,
раскрывается кнопкой "Задать координаты" с уже заполненными реальными
координатами (sceneToReal), правка поля двигает mesh (проверяется повторным
открытием блока и/или сравнением position).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

async function hideEmptyModelOverlay(page) {
  await page.evaluate(() => {
    const el = document.getElementById("empty");
    if (el) el.style.display = "none";
  });
}
// Клик-размещение (drawMode) в общем обработчике клика по канвасу шлюзуется
// modelLoaded — в реальном использовании это не проблема (кладка "Показать
// поверхность" и без того видна только когда модель уже загружена, см.
// rowShowSurface/shaftControls в index.html), но этот сценарий сеет данные
// напрямую в БД и не грузит .str, поэтому явно включает флаг через тестовый
// хук __mot3dForceModelLoadedForTest (см. index.html).
async function forceModelLoaded(page) {
  await page.evaluate(() => window.__mot3dForceModelLoadedForTest());
}
async function clickWorldPoint(page, x, y, z) {
  const screen = await page.evaluate(
    ([wx, wy, wz]) => window.__mot3dWorldToScreen(wx, wy, wz),
    [x, y, z]
  );
  await page.mouse.click(screen.x, screen.y);
}

test("плоскость-поверхность: чекбокс, клик-размещение, ручные координаты", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-surf", role: "engineer" });
  createProject(server.db, { id: "e2e-surf", name: "E2E surface" });
  seedSnapshot(server.db, "e2e-surf", { equipment: [] });

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
  await page.goto(`${server.baseUrl}/e2e-surf`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.__mot3dWorldToScreen === "function", { timeout: 8000 });
  await hideEmptyModelOverlay(page);

  await t.test("без отметки поверхности чекбокс скрыт", async () => {
    const display = await page.locator("#rowShowSurface").evaluate((el) => getComputedStyle(el).display);
    assert.equal(display, "none");
  });

  await t.test("после задания отметки чекбокс появляется", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/e2e-surf/surface-level`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tokenFor(engineer)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ surfaceLevel: 50 }),
    });
    assert.equal(resp.status, 200);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.__mot3dWorldToScreen === "function", { timeout: 8000 });
    await hideEmptyModelOverlay(page);
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById("rowShowSurface")).display !== "none",
      { timeout: 4000 }
    );
  });

  await t.test("клик по плоскости в режиме добавления оборудования размещает объект", async () => {
    await forceModelLoaded(page);
    await page.locator("#chkShowSurface").check();
    await page.locator('.tab-btn[data-tab="equip"]').click();
    await page.locator("#btnAddEquip").click();
    // surfaceLevel=50, modelOffset=[0,0,0] => мировая точка (0,50,0)
    await clickWorldPoint(page, 0, 50, 0);
    await page.waitForFunction(
      () => document.getElementById("equipDetails")?.classList.contains("open"),
      { timeout: 4000 }
    );
    // Карточка открылась на только что созданном объекте (placeEquipment(..., select=true)).
    assert.equal(await page.locator("#equipDetails").evaluate((el) => el.classList.contains("open")), true);
  });

  await t.test("координаты в карточке свёрнуты по умолчанию и раскрываются по кнопке", async () => {
    const blockDisplay = await page.locator("#equipDCoordsBlock").evaluate((el) => el.style.display);
    assert.equal(blockDisplay, "none");
    await page.locator("#equipDCoordsToggle").click();
    await page.waitForFunction(
      () => document.getElementById("equipDCoordsBlock").style.display === "block",
      { timeout: 2000 }
    );
    const z = await page.locator("#equipDCoordZ").inputValue();
    assert.equal(Number(z), 50);
  });

  await t.test("правка координаты Z двигает объект на новую высоту", async () => {
    await page.locator("#equipDCoordZ").fill("120");
    await page.locator("#equipDCoordZ").dispatchEvent("change");
    await page.locator("#equipDCoordsToggle").click(); // свернуть
    await page.locator("#equipDCoordsToggle").click(); // и открыть заново — перечитает mesh.position
    await page.waitForFunction(
      () => Number(document.getElementById("equipDCoordZ").value) === 120,
      { timeout: 2000 }
    );
  });

  assert.deepEqual(pageErrors, []);
});
