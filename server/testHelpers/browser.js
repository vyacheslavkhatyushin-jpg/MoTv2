/*
Общий запуск headless Chromium для E2E (Playwright as a library, driven
by node:test — тот же тестраннер, что и в слое 1, без отдельного
test-фреймворка @playwright/test).

executablePath: в песочнице этой сессии браузер предустановлен на
/opt/pw-browsers/chromium (см. окружение), в CI/на обычной машине его
ставит `npx playwright install chromium` в отдельный шаг workflow — тогда
этот путь просто не существует, и playwright сам резолвит браузер,
поставленный им самим. Проверяем существование файла, а не полагаемся на
переменную окружения, чтобы одинаковый код работал в обоих случаях.
*/
const fs = require("fs");
const { chromium } = require("playwright");

const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

async function launchBrowser() {
  const opts = fs.existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};
  return chromium.launch(opts);
}

module.exports = { launchBrowser };
