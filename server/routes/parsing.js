/*
Тестовая площадка для конструктора парсера потоков мониторинга — отдельная
страница /parsing (public/parsing.html), НЕ привязанная к monitorMethod
оборудования и НЕ пишущая в monitor_status/monitor_events. Задача — дать
проверить подключение и разбор сообщений на реальном стороннем сервере
(SPPD, akvs_sys_monitor, АГС и т.п.), прежде чем решать вопрос интеграции.

POST /connect логинится на указанный сервер и открывает WS-соединения на
перечисленные endpoint'ы; сырые сообщения ретранслируются в браузер через
отдельный WebSocket-канал (см. server.js, апгрейд на /api/parsing/ws) —
тем же паттерном "токен в query, не в заголовке", что уже используется для
/api/monitor/ws, так как браузерный WebSocket API не умеет слать свои
заголовки при хендшейке.

Только admin — эта страница принимает реальные логины/пароли от промышленных
систем шахты и открывает произвольные исходящие соединения с сервера.
*/
const express = require("express");
const crypto = require("crypto");
const { WebSocket } = require("ws");
const { requireAuth, requireRole } = require("../auth");
const sppd = require("../monitor/sppd-worker");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const MAX_BUFFER = 50;
const CONNECTION_TTL_MS = 30 * 60 * 1000;
// connectionId -> { sockets: WebSocket[], subscribers: Set<ws>, buffer: object[], createdAt }
const connections = new Map();

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

function broadcast(conn, payload) {
  conn.buffer.push(payload);
  if (conn.buffer.length > MAX_BUFFER) conn.buffer.shift();
  const msg = JSON.stringify(payload);
  for (const sub of conn.subscribers) {
    if (sub.readyState === sub.OPEN) sub.send(msg);
  }
}

router.post("/connect", async (req, res) => {
  const { baseUrl, authType, username, password, endpoints } = req.body || {};
  if (!baseUrl || !Array.isArray(endpoints) || !endpoints.length) {
    return res.status(400).json({ error: "invalid_config" });
  }

  let sessionCookie = "";
  if (authType === "django-session-form") {
    try {
      sessionCookie = await sppd.login({ baseUrl, username, password });
    } catch (err) {
      return res.status(502).json({ error: "auth_failed", message: err.message });
    }
  } else if (authType && authType !== "none") {
    return res.status(400).json({ error: "unsupported_auth_type" });
  }

  const connectionId = crypto.randomUUID();
  const conn = { sockets: [], subscribers: new Set(), buffer: [], createdAt: Date.now() };
  connections.set(connectionId, conn);

  const wsBase = baseUrl.replace(/^http/, "ws");
  for (const ep of endpoints) {
    if (!ep || !ep.path) continue;
    try {
      const ws = new WebSocket(`${wsBase}${ep.path}`, {
        headers: sessionCookie ? { Cookie: sessionCookie, Origin: baseUrl, Referer: `${baseUrl}/` } : {},
      });
      ws.on("message", (data) => {
        broadcast(conn, { ep: ep.name || ep.path, at: new Date().toISOString(), raw: safeParseJson(data.toString()) });
      });
      ws.on("error", (err) => {
        broadcast(conn, { ep: ep.name || ep.path, at: new Date().toISOString(), error: err.message });
      });
      ws.on("close", () => {
        broadcast(conn, { ep: ep.name || ep.path, at: new Date().toISOString(), closed: true });
      });
      conn.sockets.push(ws);
    } catch (err) {
      broadcast(conn, { ep: ep.name || ep.path, at: new Date().toISOString(), error: err.message });
    }
  }

  res.json({ connectionId });
});

router.post("/disconnect", (req, res) => {
  const { connectionId } = req.body || {};
  const conn = connections.get(connectionId);
  if (conn) {
    conn.sockets.forEach((ws) => {
      try {
        ws.close();
      } catch (e) {}
    });
    for (const sub of conn.subscribers) {
      try {
        sub.close();
      } catch (e) {}
    }
    connections.delete(connectionId);
  }
  res.json({ ok: true });
});

// Аварийная уборка — тестовое подключение живёт не дольше получаса, даже
// если браузер закрыли без нажатия "Остановить".
setInterval(() => {
  const now = Date.now();
  for (const [id, conn] of connections) {
    if (now - conn.createdAt > CONNECTION_TTL_MS) {
      conn.sockets.forEach((ws) => {
        try {
          ws.close();
        } catch (e) {}
      });
      for (const sub of conn.subscribers) {
        try {
          sub.close();
        } catch (e) {}
      }
      connections.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// Вызывается из server.js при апгрейде WS-канала браузера — подписывает
// его на уже открытое тестовое подключение и сразу отдаёт то, что успело
// накопиться в буфере.
function subscribe(connectionId, ws) {
  const conn = connections.get(connectionId);
  if (!conn) return false;
  conn.subscribers.add(ws);
  for (const item of conn.buffer) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(item));
  }
  ws.on("close", () => conn.subscribers.delete(ws));
  return true;
}

module.exports = { router, subscribe };
