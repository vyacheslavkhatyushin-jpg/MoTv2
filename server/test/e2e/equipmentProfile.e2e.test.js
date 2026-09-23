/*
E2E: детектор "должно быть, но не пришло" в карточке "Инфо" — профиль формы
даёт ожидаемый список атрибутов; то, что реально пришло в raw_metrics_json,
показывается значением, то, чего нет — явно как "нет данных" (приглушённым
цветом), а не молчаливым отсутствием строки (см. metricsRowsHtml в
public/index.html и обсуждение в этой сессии: раньше "не пришла метрика" и
"эта форма вообще её не даёт" были неотличимы).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, seedMonitorStatus, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

test("карточка Инфо: показывает 'нет данных' для метрики профиля, которая не пришла", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-profile", role: "engineer" });
  createProject(server.db, { id: "e2e-profile", name: "E2E profile" });
  // shape "iilb" — из сида db.js уже имеет профиль по умолчанию p-iilb
  // (online/personCount/vehicleCount/rssi, см. seedShapeDefault в db.js).
  seedSnapshot(server.db, "e2e-profile", {
    equipment: [{
      id: "iilb1", label: "IILB-тест", shape: "iilb", position: [0, 0, 0], size: 5,
      monitorMethod: "custom", dataSourceId: "src1", sourceAddress: "42",
    }],
  });
  // Источник прислал online + personCount, но НЕ vehicleCount/rssi — их
  // профиль ожидает, детектор должен явно показать "нет данных" на обоих.
  seedMonitorStatus(server.db, "e2e-profile", "iilb1", {
    state: "up",
    rawMetrics: { online: true, personCount: 7 },
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
  await page.goto(`${server.baseUrl}/e2e-profile`);
  await page.click('.tab-btn[data-tab="equip"]');
  await page.waitForSelector("#equipList .uo-group-header", { timeout: 8000 });
  await page.click("#equipList .uo-group-header"); // группы формы свёрнуты по умолчанию
  await page.waitForSelector("#equipList .uo-row", { timeout: 4000 });
  // loadEquipmentProfilesOnce() — fire-and-forget при старте (как и каталог
  // атрибутов рядом с ним), даём ему точно долететь до клика, иначе первая
  // отрисовка карточки могла бы не знать о профиле формы.
  await page.waitForTimeout(500);
  await page.click("#equipList .uo-row");
  await page.waitForTimeout(600); // refreshQuickInfoMetrics — REST-опрос статуса

  await t.test("пришедшая метрика (Счётчик людей) показана значением", async () => {
    const text = await page.locator("#quickInfoBody").innerText();
    assert.match(text, /Счётчик людей[\s\S]*7/);
  });

  await t.test("непришедшая метрика профиля (Счётчик техники) — явно 'нет данных'", async () => {
    const text = await page.locator("#quickInfoBody").innerText();
    assert.match(text, /Счётчик техники[\s\S]*нет данных/);
  });

  await t.test("непришедшая метрика профиля (RSSI) — тоже 'нет данных'", async () => {
    const text = await page.locator("#quickInfoBody").innerText();
    assert.match(text, /RSSI[\s\S]*нет данных/);
  });

  await t.test("ни одной ошибки в консоли", () => {
    assert.deepEqual(pageErrors, []);
  });
});
