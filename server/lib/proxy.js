/*
Глобальный fetch() Node сам по себе НЕ читает HTTP_PROXY/HTTPS_PROXY (в
отличие от googleapis/gaxios, которые это умеют из коробки) — на сервере
за корпоративным прокси (см. docs/backup-setup.md, диагностика "fetch
failed" при подключении Google Drive) это ломает наши собственные вызовы
fetch() (server/backup/gdrive-oauth.js — Device Flow к oauth2.googleapis.com).
Вызывается один раз при старте процесса (server.js и backup-worker.js).
*/
const { ProxyAgent, setGlobalDispatcher } = require("undici");

function setupProxyDispatcher() {
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) return;
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[proxy] исходящий fetch() настроен через ${proxyUrl}`);
}

module.exports = { setupProxyDispatcher };
