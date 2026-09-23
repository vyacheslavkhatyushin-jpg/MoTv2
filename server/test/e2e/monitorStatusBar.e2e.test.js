/*
E2E: статус-бар мониторинга (под "Активными авариями") — golden path этой
сессии: подписи Online/Alarm/RegTag/Транспорт, клик по каждой открывает
модалку со списком устройств категории, закрытие тремя способами, кнопка
тикета в Alarm.

Заодно неявно проверяет, что public/vendor/three/ (локальная копия
three.js) реально грузится и работает — если бы importmap был битый или
файлы не отдавались, страница вообще не дошла бы до #monitorBtnOnline.

Логин — не через форму (это отдельный сценарий в auth.e2e.test.js), а
прямой инжект kzmAuthSession в localStorage до навигации: быстрее и не
дублирует то, что уже покрыто.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, seedMonitorStatus, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

async function loginViaLocalStorage(page, baseUrl, user) {
  // localStorage привязан к origin — сначала грузим любую страницу с
  // сервера, потом уже пишем kzmAuthSession и переходим на целевую.
  await page.goto(baseUrl + "/");
  await page.evaluate(
    (session) => localStorage.setItem("kzmAuthSession", JSON.stringify(session)),
    { token: tokenFor(user), username: user.username, role: user.role }
  );
}

test("статус-бар мониторинга: подписи, счётчики, клик открывает модалку со списком", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const admin = createUser(server.db, { username: "e2e-admin", role: "admin" });
  createProject(server.db, { id: "e2e-mon", name: "E2E monitor" });
  seedSnapshot(server.db, "e2e-mon", {
    equipment: [
      { id: "map1", label: "МАП-1", shape: "sensor", position: [0, 0, 0], size: 5, monitorMethod: "ping", ip: "10.0.0.1" },
      { id: "map2", label: "МАП-2", shape: "sensor", position: [10, 0, 0], size: 5, monitorMethod: "ping", ip: "10.0.0.2" },
      { id: "reader1", label: "Считыватель-1", shape: "sensor", position: [20, 0, 0], size: 5, monitorMethod: "custom", dataSourceId: 1, sourceAddress: "r1" },
    ],
  });
  seedMonitorStatus(server.db, "e2e-mon", "map1", { state: "up" });
  seedMonitorStatus(server.db, "e2e-mon", "map2", { state: "down" });
  seedMonitorStatus(server.db, "e2e-mon", "reader1", { state: "up", personCount: 5 });

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await loginViaLocalStorage(page, server.baseUrl, admin);
  await page.goto(`${server.baseUrl}/e2e-mon/monitoring`);
  await page.waitForSelector("#monitorBtnOnline", { timeout: 8000 });
  await page.waitForTimeout(1200); // первое WS-сообщение статуса

  await t.test("бар: правильные подписи и счётчики, 'Неизвестно' нигде нет", async () => {
    const barText = await page.locator(".tabpanel#tab-monitor .panel-row").first().innerText();
    assert.match(barText, /Online/);
    assert.match(barText, /Alarm/);
    assert.match(barText, /RegTag/);
    assert.doesNotMatch(barText, /Неизвестно/);
    assert.equal(await page.locator("#monitorCountUp").innerText(), "2");
    assert.equal(await page.locator("#monitorCountDown").innerText(), "1");
  });

  await t.test("клик по Online открывает модалку со списком из 2 устройств", async () => {
    await page.click("#monitorBtnOnline");
    await page.waitForSelector("#monitorStatModal.open", { timeout: 4000 });
    const items = await page.locator("#monitorStatModalList .uo-row").count();
    assert.equal(items, 2);
    await page.click("#monitorStatModalClose");
    await page.waitForSelector("#monitorStatModal:not(.open)", { state: "attached", timeout: 4000 });
  });

  await t.test("клик по Alarm — модалка с кнопкой тикета у строки", async () => {
    await page.click("#monitorBtnAlarm");
    await page.waitForSelector("#monitorStatModal.open", { timeout: 4000 });
    assert.equal(await page.locator("#monitorStatModalList .uo-row").count(), 1);
    assert.equal(await page.locator("#monitorStatModalList .mk-ticket-btn").count(), 1);
    // закрытие кликом по фону
    await page.mouse.click(10, 10);
    await page.waitForSelector("#monitorStatModal:not(.open)", { state: "attached", timeout: 4000 });
  });

  await t.test("клик по RegTag — модалка без кнопки тикета, закрытие по Esc", async () => {
    await page.click("#monitorBtnRegtag");
    await page.waitForSelector("#monitorStatModal.open", { timeout: 4000 });
    assert.equal(await page.locator("#monitorStatModalList .mk-ticket-btn").count(), 0);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#monitorStatModal:not(.open)", { state: "attached", timeout: 4000 });
  });

  await t.test("ни одной ошибки в консоли страницы за весь сценарий", () => {
    assert.deepEqual(pageErrors, []);
  });
});
