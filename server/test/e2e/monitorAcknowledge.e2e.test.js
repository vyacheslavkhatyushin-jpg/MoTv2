/*
E2E: подтверждение аварии из списка "Активные аварии" — клик по кнопке
"✓" красит строку/подсветку в янтарный и подставляет логин вместо кнопки.
Регрессия на то, что весь путь (клик → POST → следующий applyMonitorStatus)
реально работает в браузере, не только на уровне HTTP (см.
test/integration/monitorAcknowledge.test.js).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, seedMonitorStatus, tokenFor } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

function seedOpenEvent(db, projectId, equipmentId, label) {
  const info = db
    .prepare(
      `INSERT INTO monitor_events (project_id, equipment_id, equipment_label, from_state, to_state, started_at)
       VALUES (?, ?, ?, 'up', 'down', datetime('now'))`
    )
    .run(projectId, equipmentId, label);
  return info.lastInsertRowid;
}

test("подтверждение аварии из списка активных аварий", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const engineer = createUser(server.db, { username: "e2e-ack", role: "engineer" });
  createProject(server.db, { id: "e2e-ack", name: "E2E ack" });
  seedSnapshot(server.db, "e2e-ack", {
    equipment: [{ id: "map1", label: "МАП-1", shape: "sensor", position: [0, 0, 0], size: 5, monitorMethod: "ping", ip: "10.0.0.1" }],
  });
  seedMonitorStatus(server.db, "e2e-ack", "map1", { state: "down" });
  seedOpenEvent(server.db, "e2e-ack", "map1", "МАП-1");

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
  await page.goto(`${server.baseUrl}/e2e-ack/monitoring`);
  await page.waitForSelector("#monitorActiveList .uo-row", { timeout: 8000 });

  await t.test("до подтверждения: красный swatch, есть кнопка подтверждения", async () => {
    const swatchColor = await page.locator("#monitorActiveList .uo-row .swatch").first().evaluate((el) => el.style.background);
    assert.match(swatchColor, /230, *85, *61|#e74c3c|rgb\(231, *76, *60\)/);
    // ackBtn — второй .mk-ticket-btn (первый — сам чек, есть title "Подтвердить…")
    const ackBtn = page.locator('#monitorActiveList .uo-row button[title*="Подтвердить"]');
    await assert.doesNotReject(ackBtn.waitFor({ state: "attached", timeout: 2000 }));
  });

  await page.click('#monitorActiveList .uo-row button[title*="Подтвердить"]');
  await page.waitForSelector('#monitorActiveList .uo-row', { timeout: 4000 });
  await page.waitForFunction(
    () => document.querySelector("#monitorActiveList .uo-row")?.textContent.includes("e2e-ack"),
    { timeout: 4000 }
  );

  await t.test("после подтверждения: янтарный swatch, логин вместо кнопки", async () => {
    const swatchColor = await page.locator("#monitorActiveList .uo-row .swatch").first().evaluate((el) => el.style.background);
    assert.match(swatchColor, /243, *156, *18|#f39c12/);
    const rowText = await page.locator("#monitorActiveList .uo-row").first().innerText();
    assert.match(rowText, /e2e-ack/);
    const ackBtnGone = await page.locator('#monitorActiveList .uo-row button[title*="Подтвердить"]').count();
    assert.equal(ackBtnGone, 0);
  });

  await t.test("ни одной ошибки в консоли за весь сценарий", () => {
    assert.deepEqual(pageErrors, []);
  });
});
