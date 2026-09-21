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

admin и supervisor — эта страница принимает реальные логины/пароли от
промышленных систем шахты и открывает произвольные исходящие соединения
с сервера (Источники данных — один из разделов "Настройки", supervisor
управляет ими наравне с admin).
*/
const express = require("express");
const crypto = require("crypto");
const { WebSocket } = require("ws");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const shared = require("../lib/monitorShared");

const router = express.Router();
router.use(requireAuth, requireRole("admin", "supervisor"));

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
      sessionCookie = await shared.login({ baseUrl, username, password });
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

/* ================================================================
   Источники данных на проект (project_data_sources) — "публикация"
   конфигурации, проверенной выше через /connect, в постоянный источник,
   который забирает custom-monitor-worker.js. Само сохранение конфига
   никак не подключается к monitor_status — этим занимается воркер,
   читающий эту таблицу отдельно от HTTP-запросов этой страницы.
   ================================================================ */

function rowToSource(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    connection: JSON.parse(row.connection_json),
    parser: JSON.parse(row.parser_json),
    enabled: !!row.enabled,
    updatedAt: row.updated_at,
  };
}

router.get("/sources", (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: "missing_project_id" });
  const rows = db
    .prepare("SELECT * FROM project_data_sources WHERE project_id = ? ORDER BY name")
    .all(String(projectId).toLowerCase());
  res.json({ sources: rows.map(rowToSource) });
});

router.post("/sources", (req, res) => {
  const { projectId, name, connection, parser } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "missing_project_id" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "missing_name" });
  if (!connection || typeof connection !== "object") return res.status(400).json({ error: "missing_connection" });
  if (!parser || typeof parser !== "object") return res.status(400).json({ error: "missing_parser" });
  const pid = String(projectId).toLowerCase();
  const project = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(pid);
  if (!project) return res.status(404).json({ error: "project_not_found" });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO project_data_sources (id, project_id, name, connection_json, parser_json, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, pid, name.trim(), JSON.stringify(connection), JSON.stringify(parser), req.user.username, req.user.username);
  logAudit({
    actor: req.user.username, projectId: pid, action: "data_source.create",
    entityType: "data_source", entityId: id, entityLabel: name, ip: req.ip,
  });
  res.status(201).json({ id });
});

router.patch("/sources/:id", (req, res) => {
  const { id } = req.params;
  const existing = db.prepare("SELECT * FROM project_data_sources WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const { name, connection, parser, enabled } = req.body || {};
  const next = {
    name: name !== undefined ? String(name).trim() : existing.name,
    connection: connection !== undefined ? JSON.stringify(connection) : existing.connection_json,
    parser: parser !== undefined ? JSON.stringify(parser) : existing.parser_json,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
  };
  if (!next.name) return res.status(400).json({ error: "missing_name" });
  db.prepare(
    `UPDATE project_data_sources SET name = ?, connection_json = ?, parser_json = ?, enabled = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(next.name, next.connection, next.parser, next.enabled, req.user.username, id);
  logAudit({
    actor: req.user.username, projectId: existing.project_id, action: "data_source.update",
    entityType: "data_source", entityId: id, entityLabel: next.name, ip: req.ip,
  });
  res.json({ ok: true });
});

router.delete("/sources/:id", (req, res) => {
  const { id } = req.params;
  const existing = db.prepare("SELECT * FROM project_data_sources WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM project_data_sources WHERE id = ?").run(id);
  logAudit({
    actor: req.user.username, projectId: existing.project_id, action: "data_source.delete",
    entityType: "data_source", entityId: id, entityLabel: existing.name, ip: req.ip,
  });
  res.json({ ok: true });
});

module.exports = { router, subscribe };
