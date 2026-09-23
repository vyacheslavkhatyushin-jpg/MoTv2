/*
Исходящий HTTP(S)-прокси для fetch() (Настройки → Сеть, admin) —
общесерверная настройка, не привязана к конкретной фиче: на разных
площадках может стоять разный корпоративный прокси или не быть его
вовсе. Приоритет: значение из БД (server_settings.outbound_proxy_url,
задаётся через UI) — если пусто, фолбэк на HTTPS_PROXY/HTTP_PROXY из
окружения (см. docker-compose.yml). Глобальный fetch() Node сам по себе
НЕ читает эти переменные (в отличие от googleapis/gaxios, которые это
умеют из коробки) — отсюда и весь этот модуль.
*/
const { Agent, ProxyAgent, setGlobalDispatcher } = require("undici");
const db = require("../db");

function envProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
}

function getConfiguredProxyUrl() {
  let dbValue = "";
  try {
    const row = db.prepare("SELECT outbound_proxy_url FROM server_settings WHERE id = 1").get();
    dbValue = (row && row.outbound_proxy_url) || "";
  } catch (e) {
    // Таблица могла ещё не существовать на очень старой инсталляции до
    // миграции — не валим процесс на старте из-за этого.
  }
  return dbValue || envProxyUrl();
}

// Применяет прокси сразу, без перезапуска процесса — вызывается и при
// старте (setupProxyDispatcher), и сразу после сохранения в Настройки →
// Сеть (см. server/routes/network.js).
function applyProxy(url) {
  if (url) {
    setGlobalDispatcher(new ProxyAgent(url));
    console.log(`[proxy] исходящий fetch() настроен через ${url}`);
  } else {
    setGlobalDispatcher(new Agent());
  }
}

function setupProxyDispatcher() {
  applyProxy(getConfiguredProxyUrl());
}

module.exports = { setupProxyDispatcher, applyProxy, getConfiguredProxyUrl };
