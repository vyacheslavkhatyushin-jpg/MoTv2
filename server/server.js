const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const usersRoutes = require("./routes/users");
const { verifyToken } = require("./auth");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Snapshots embed parsed STR/DTM geometry and can be large.
app.use(express.json({ limit: "300mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/users", usersRoutes);

app.use(express.static(path.join(__dirname, "..", "public")));

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
const wss = new WebSocketServer({ noServer: true });
const monitorClients = new Map(); // projectId -> Set<ws>

function getMonitorStatus(projectId) {
  return db
    .prepare(
      `SELECT equipment_id, state, last_checked_at, last_change_at, latency_ms,
              person_count, vehicle_count
       FROM monitor_status WHERE project_id = ?`
    )
    .all(projectId);
}

function sendStatus(ws, projectId) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "status", status: getMonitorStatus(projectId) }));
}

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (e) {
    socket.destroy();
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
  });
});

const BROADCAST_INTERVAL_MS = parseInt(process.env.MONITOR_BROADCAST_INTERVAL_MS || "5000", 10);
setInterval(() => {
  for (const [projectId, clients] of monitorClients) {
    if (!clients.size) continue;
    const payload = JSON.stringify({ type: "status", status: getMonitorStatus(projectId) });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}, BROADCAST_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Mine Operations Tool server listening on port ${PORT}`);
});
