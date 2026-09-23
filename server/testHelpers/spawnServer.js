/*
Тестовый харнесс: поднимает реальный server.js как отдельный процесс на
своей БД и порту — так же, как это вручную делалось при ручном тестировании
фич этой сессии (DB_PATH/JWT_SECRET/PORT через env). Не требует рефакторинга
server.js под "app.listen опционально" — server.js как был самодостаточным
скриптом, так и остаётся; тесты просто управляют им как чёрным ящиком через
HTTP, ровно как это делает браузер в проде.

Каждый вызов startServer() — отдельная временная SQLite (+ WAL/SHM файлы
рядом) в своей папке под os.tmpdir(), поэтому тесты можно гонять параллельно
(node --test сам параллелит файлы) без пересечений данных.
*/
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const TEST_JWT_SECRET = "test_jwt_secret_do_not_use_in_prod";

async function waitForReady(baseUrl, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(baseUrl + "/");
      if (resp.ok || resp.status === 404) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Сервер не поднялся за ${timeoutMs}мс: ${lastErr ? lastErr.message : "нет ответа"}`);
}

// Порт 0 у самого Node дал бы свободный порт автоматически, но server.js
// сам делает server.listen(PORT) с фиксированным числом из env — здесь
// эмулируем "свободный порт" через короткоживущий листенер на 0, читаем
// его номер и тут же закрываем, передавая число дочернему процессу.
async function getFreePort() {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env = {}) {
  const port = await getFreePort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mot-test-"));
  const dbPath = path.join(workDir, "test.db");

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: TEST_JWT_SECRET,
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl);
  } catch (e) {
    child.kill("SIGKILL");
    throw new Error(`${e.message}\n--- вывод сервера ---\n${logs.join("")}`);
  }

  // Своя db-хендл на ТУ ЖЕ БД для прямого сидинга/проверок в тестах —
  // отдельный процесс (server.js) и этот хендл открывают один файл,
  // better-sqlite3 в WAL это поддерживает. НЕ используем require("../../db")
  // тут: тот модуль — синглтон, кэширующийся по первому require() в
  // процессе, а не по DB_PATH — второй startServer() в том же файле теста
  // получил бы соединение от ПЕРВОГО запуска. Открываем сырой better-sqlite3
  // напрямую вместо него; схема к этому моменту уже создана дочерним
  // процессом (server.js требует ../db при старте).
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    db.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return { baseUrl, port, dbPath, db, child, logs, stop };
}

module.exports = { startServer, TEST_JWT_SECRET };
