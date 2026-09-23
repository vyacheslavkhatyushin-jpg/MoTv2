const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const { WebSocketServer } = require("ws");

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const usersRoutes = require("./routes/users");
const zipRoutes = require("./routes/zip");
const lampsRoutes = require("./routes/lamps");
const auditRoutes = require("./routes/audit");
const ticketsRoutes = require("./routes/tickets");
const parsingRoutes = require("./routes/parsing");
const referencesRoutes = require("./routes/references");
const backupRoutes = require("./routes/backup");
const networkRoutes = require("./routes/network");
const { verifyToken } = require("./auth");
const db = require("./db");
const { setupProxyDispatcher } = require("./lib/proxy");

setupProxyDispatcher();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// gzip/brotli на ответы — project snapshot (STR/DTM-геометрия) и сам
// index.html отдаются как сырой JSON/текст без сжатия, что почти незаметно
// на локалхосте (loopback), но ощутимо лагает по реальной сети, особенно
// на площадках с небогатым интернетом. Сжимает только исходящие ответы,
// на приём тела запроса (загрузка модели) не влияет.
app.use(compression());
// Snapshots embed parsed STR/DTM geometry and can be large.
app.use(express.json({ limit: "300mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/projects", zipRoutes);
app.use("/api/projects", lampsRoutes);
app.use("/api/projects", ticketsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/audit-log", auditRoutes);
app.use("/api/parsing", parsingRoutes.router);
app.use("/api/references", referencesRoutes);
app.use("/api/backup", backupRoutes);
app.use("/api/network", networkRoutes);

app.use(express.static(path.join(__dirname, "..", "public")));

// Реестр ЗИП — отдельная лёгкая страница (без Three.js), не часть index.html
// SPA-роутинга ниже. Должно идти раньше общего catch-all.
app.get(/^\/[^/]+\/registry\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "registry.html"));
});

// Дашборд "История аварий" (/<project>/monitoring/stats) — тоже отдельная
// лёгкая страница без Three.js, поверх /api/projects/:id/monitor/stats.
app.get(/^\/[^/]+\/monitoring\/stats\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "monitoring-stats.html"));
});

// Фонари — отдельная лёгкая страница, поверх /api/projects/:id/lamps/reports.
app.get(/^\/[^/]+\/lamps\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "lamps.html"));
});

// Журнал действий — admin/supervisor, поверх /api/audit-log.
app.get(/^\/[^/]+\/log\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "log.html"));
});

// Тикеты — устранение аварий/находок, поверх /api/projects/:id/tickets.
app.get(/^\/[^/]+\/tickets\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "tickets.html"));
});

// Настройки — единый раздел админки (Пользователи/Пороги/Справочники/
// Источники данных), см. модуль "Настройки" в docs/monitoring-plan.md.
// Project-scoped, как Лог/Фонари выше (Пользователи/Пороги — per-project).
// Доступен admin и supervisor — но Пользователи/Справочники внутри видит
// только admin (гейтится на клиенте settings.html + на сервере отдельно
// для /api/users и /api/references).
app.get(/^\/[^/]+\/settings\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "settings.html"));
});

// Конструктор/тестер парсера потоков — не привязан к проекту, admin/supervisor.
// См. server/routes/parsing.js и docs.
app.get(/^\/parsing\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "parsing.html"));
});

// Справочники объектов (атрибуты/профили оборудования/типы кабелей) — не
// привязано к проекту, только admin. См. server/routes/references.js.
app.get(/^\/references\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "references.html"));
});

// SPA: any other GET (e.g. /:projectId) serves the app; the frontend reads
// the project id from the URL path itself.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

/* ============================================================
   Мониторинг: живой статус оборудования по WebSocket (см.
   docs/monitoring-plan.md). Отдельные воркеры (server/monitor/*)
   пишут monitor_status/monitor_events в SQLite; этот канал просто
   периодически перечитывает monitor_status по проекту и рассылает
   его всем подключённым вкладкам — воркеры сами по WebSocket ни с
   кем не общаются, только с базой.
   Браузерный WebSocket API не умеет слать свои заголовки при
   хендшейке, поэтому токен передаётся query-параметром, а не
   Authorization-заголовком, как в обычных REST-запросах.
============================================================ */
const server = http.createServer(app);
// perMessageDeflate — статусы мониторинга шлются всем подключённым вкладкам
// раз в BROADCAST_INTERVAL_MS сырым JSON; на проекте с сотнями объектов
// это ощутимый трафик по реальной сети без сжатия (по умолчанию 'ws' его
// не включает).
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
const monitorClients = new Map(); // projectId -> Set<ws>

function getMonitorStatus(projectId) {
  return db
    .prepare(
      `SELECT equipment_id, state, last_checked_at, last_change_at, latency_ms,
              person_count, vehicle_count, raw_metrics_json
       FROM monitor_status WHERE project_id = ?`
    )
    .all(projectId);
}

function sendStatus(ws, projectId) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "status", status: getMonitorStatus(projectId) }));
}

// Разовая белая вспышка "новая метка на считывателе" — воркеры мониторинга
// (custom-monitor-worker.js через shared.emitTagPulse) пишут ряды в
// monitor_tag_pulses по мере обнаружения, этот процесс на каждом цикле
// рассылки подбирает свежие
// (после lastTagPulseSent для проекта) и шлёт клиентам. Курсор берём из
// SQLite (`datetime('now')`), а не из JS Date().toISOString() — форматы
// разные ("YYYY-MM-DD HH:MM:SS" против "...THH:MM:SS.sssZ"), и обычное
// сравнение строк ">" сравнивало бы их неверно. lastTagPulseSent
// стартует с момента запуска сервера, чтобы не пересылать вспышки,
// накопленные до перезапуска.
function sqliteNow() {
  return db.prepare("SELECT datetime('now') AS now").get().now;
}
const lastTagPulseSent = new Map(); // projectId -> SQLite datetime string
const serverStartSqlite = sqliteNow();
function getFreshTagPulses(projectId) {
  const since = lastTagPulseSent.get(projectId) || serverStartSqlite;
  const rows = db
    .prepare("SELECT equipment_id, created_at FROM monitor_tag_pulses WHERE project_id = ? AND created_at > ? ORDER BY created_at")
    .all(projectId, since);
  if (rows.length) lastTagPulseSent.set(projectId, rows[rows.length - 1].created_at);
  return rows;
}

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (e) {
    socket.destroy();
    return;
  }
  if (url.pathname === "/api/parsing/ws") {
    const connectionId = url.searchParams.get("connectionId") || "";
    const token = url.searchParams.get("token") || "";
    let payload;
    try {
      payload = verifyToken(token);
    } catch (e) {
      socket.destroy();
      return;
    }
    if (payload.role !== "admin" || !connectionId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!parsingRoutes.subscribe(connectionId, ws)) ws.close();
    });
    return;
  }

  if (url.pathname !== "/api/monitor/ws") {
    socket.destroy();
    return;
  }
  const projectId = (url.searchParams.get("project") || "").toLowerCase();
  const token = url.searchParams.get("token") || "";
  if (!projectId) {
    socket.destroy();
    return;
  }
  try {
    verifyToken(token);
  } catch (e) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.projectId = projectId;
    if (!monitorClients.has(projectId)) monitorClients.set(projectId, new Set());
    monitorClients.get(projectId).add(ws);
    ws.on("close", () => {
      monitorClients.get(projectId)?.delete(ws);
    });
    sendStatus(ws, projectId);
    // Курсор для нового клиента стартует с "сейчас" — не заваливаем его
    // вспышками, случившимися до подключения.
    lastTagPulseSent.set(projectId, sqliteNow());
  });
});

const BROADCAST_INTERVAL_MS = parseInt(process.env.MONITOR_BROADCAST_INTERVAL_MS || "5000", 10);
setInterval(() => {
  for (const [projectId, clients] of monitorClients) {
    if (!clients.size) continue;
    const statusPayload = JSON.stringify({ type: "status", status: getMonitorStatus(projectId) });
    const pulses = getFreshTagPulses(projectId);
    const pulsePayload = pulses.length
      ? JSON.stringify({ type: "tagPulse", equipmentIds: pulses.map((p) => p.equipment_id) })
      : null;
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(statusPayload);
      if (pulsePayload) ws.send(pulsePayload);
    }
  }
}, BROADCAST_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Mine Operations Tool server listening on port ${PORT}`);
});
