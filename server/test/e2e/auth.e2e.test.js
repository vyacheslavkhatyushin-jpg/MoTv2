/*
E2E: экран входа (#authGate) — golden path логина, доступный на любой
странице SPA (index.html читает embeddedState/JWT из localStorage так же
на / и на /:project/monitoring).
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject } = require("../../testHelpers/seed");
const { launchBrowser } = require("../../testHelpers/browser");

test("вход в систему: неверный пароль показывает ошибку, верный — пускает в приложение", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  createUser(server.db, { username: "e2e-user", password: "Correct-Horse-1", role: "engineer" });
  createProject(server.db, { id: "e2e-auth", name: "E2E auth" });

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());

  await page.goto(`${server.baseUrl}/e2e-auth`);
  await page.waitForSelector("#authGate", { state: "visible" });

  await t.test("неверный пароль — остаёмся на экране входа, видим ошибку", async () => {
    await page.fill("#authUsername", "e2e-user");
    await page.fill("#authPassword", "wrong-password");
    await page.click("#btnAuthSubmit");
    await page.waitForFunction(() => document.querySelector("#authError")?.textContent.trim().length > 0);
    await assert.doesNotReject(page.waitForSelector("#authGate", { state: "visible", timeout: 1000 }));
  });

  await t.test("верный пароль — экран входа скрывается, приложение открывается", async () => {
    await page.fill("#authUsername", "e2e-user");
    await page.fill("#authPassword", "Correct-Horse-1");
    await page.click("#btnAuthSubmit");
    await page.waitForSelector("#authGate.hidden", { state: "attached", timeout: 8000 });
    await page.waitForSelector("#app", { state: "visible", timeout: 8000 });
  });
});
