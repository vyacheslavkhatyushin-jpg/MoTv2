/*
Тикетинг — устранение аварий/находок эксплуатацией (см. tickets/ticket_comments/
ticket_attachments в db.js). Тикет может быть общим (без привязки к
оборудованию) — equipment_id/equipment_label nullable.

Роли: смотреть может любой авторизованный (viewer и выше); создавать тикет
и комментировать/прикладывать фото — editor/admin; назначать
исполнителя, менять приоритет, отменять тикет — только admin; менять
статус (взял в работу → на проверке → закрыт, с resolution_note) может
исполнитель (assignee) или admin.
*/
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const { notifyTicketEvent } = require("../lib/notify");

const router = express.Router();
router.use(requireAuth);

router.param("id", (req, res, next, id) => {
  req.params.id = id.toLowerCase();
  next();
});

function requireProject(req, res) {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project_not_found" });
    return null;
  }
  return project;
}

function requireTicket(req, res) {
  const ticket = db
    .prepare("SELECT * FROM tickets WHERE id = ? AND project_id = ?")
    .get(req.params.ticketId, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: "ticket_not_found" });
    return null;
  }
  return ticket;
}

const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["new", "assigned", "in_progress", "on_review", "closed", "cancelled"];
const SLA_COLUMN_BY_PRIORITY = {
  critical: "ticket_sla_critical_hours",
  high: "ticket_sla_high_hours",
  medium: "ticket_sla_medium_hours",
  low: "ticket_sla_low_hours",
};
const SLA_DEFAULTS = { critical: 2, high: 8, medium: 24, low: 72 };

function getSlaHours(projectId, priority) {
  const row = db.prepare("SELECT * FROM project_monitor_thresholds WHERE project_id = ?").get(projectId);
  const col = SLA_COLUMN_BY_PRIORITY[priority];
  if (row && Number.isInteger(row[col])) return row[col];
  return SLA_DEFAULTS[priority];
}

function serializeTicket(row) {
  const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
  const isOverdue = !!(row.due_at && !["closed", "cancelled"].includes(row.status) && row.due_at < nowIso);
  return {
    id: row.id,
    projectId: row.project_id,
    equipmentId: row.equipment_id,
    equipmentLabel: row.equipment_label,
    monitorEventId: row.monitor_event_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    createdBy: row.created_by,
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    dueAt: row.due_at,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    resolutionNote: row.resolution_note,
    isOverdue,
  };
}

function serializeComment(row) {
  return { id: row.id, ticketId: row.ticket_id, author: row.author, body: row.body, createdAt: row.created_at };
}

function serializeAttachment(row) {
  return {
    id: row.id, ticketId: row.ticket_id, commentId: row.comment_id,
    filename: row.filename, mimeType: row.mime_type, size: row.size,
    uploadedBy: row.uploaded_by, createdAt: row.created_at,
  };
}

router.get("/:id/tickets", (req, res) => {
  if (!requireProject(req, res)) return;
  const clauses = ["project_id = @projectId"];
  const params = { projectId: req.params.id };
  if (req.query.status && STATUSES.includes(req.query.status)) {
    clauses.push("status = @status");
    params.status = req.query.status;
  }
  if (req.query.priority && PRIORITIES.includes(req.query.priority)) {
    clauses.push("priority = @priority");
    params.priority = req.query.priority;
  }
  if (req.query.assignee) {
    clauses.push("assignee = @assignee");
    params.assignee = req.query.assignee;
  }
  if (req.query.equipmentId) {
    clauses.push("equipment_id = @equipmentId");
    params.equipmentId = req.query.equipmentId;
  }
  const rows = db
    .prepare(`SELECT * FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
    .all(params);
  let tickets = rows.map(serializeTicket);
  if (req.query.overdue === "1") tickets = tickets.filter((t) => t.isOverdue);
  res.json({ tickets });
});

router.get("/:id/tickets/:ticketId", (req, res) => {
  if (!requireProject(req, res)) return;
  const ticket = requireTicket(req, res);
  if (!ticket) return;
  const comments = db
    .prepare("SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at")
    .all(ticket.id)
    .map(serializeComment);
  const attachments = db
    .prepare("SELECT id, ticket_id, comment_id, filename, mime_type, size, uploaded_by, created_at FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at")
    .all(ticket.id)
    .map(serializeAttachment);
  res.json({ ticket: serializeTicket(ticket), comments, attachments });
});

router.post("/:id/tickets", requireRole("editor", "admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const { title, description, priority, equipmentId, equipmentLabel, monitorEventId } = req.body || {};
  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title_required" });
  }
  const prio = PRIORITIES.includes(priority) ? priority : "medium";

  const info = db
    .prepare(
      `INSERT INTO tickets (project_id, equipment_id, equipment_label, monitor_event_id, title, description, priority, created_by)
       VALUES (@projectId, @equipmentId, @equipmentLabel, @monitorEventId, @title, @description, @priority, @createdBy)`
    )
    .run({
      projectId: req.params.id,
      equipmentId: equipmentId || null,
      equipmentLabel: equipmentLabel || null,
      monitorEventId: Number.isInteger(monitorEventId) ? monitorEventId : null,
      title: title.trim(),
      description: description || null,
      priority: prio,
      createdBy: req.user.username,
    });

  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(info.lastInsertRowid);
  logAudit({
    actor: req.user.username, projectId: req.params.id, action: "ticket.create",
    entityType: "ticket", entityId: ticket.id, entityLabel: ticket.title, ip: req.ip,
  });
  res.status(201).json({ ticket: serializeTicket(ticket) });
});

router.patch("/:id/tickets/:ticketId", requireRole("editor", "admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const ticket = requireTicket(req, res);
  if (!ticket) return;
  const isAdmin = req.user.role === "admin";
  const isAssignee = ticket.assignee === req.user.username;
  const body = req.body || {};

  // Закрытый/отменённый тикет — терминальное состояние для исполнителя;
  // трогать его дальше (в т.ч. пытаться сменить статус обратно) может
  // только admin, например чтобы поправить ошибочное закрытие.
  if (["closed", "cancelled"].includes(ticket.status) && !isAdmin) {
    return res.status(403).json({ error: "forbidden", message: "Тикет закрыт — изменения доступны только admin" });
  }

  const updates = {};
  const auditEvents = [];

  if (Object.prototype.hasOwnProperty.call(body, "assignee")) {
    if (!isAdmin) return res.status(403).json({ error: "forbidden", message: "Назначать исполнителя может только admin" });
    const newAssignee = body.assignee || null;
    updates.assignee = newAssignee;
    if (newAssignee) {
      if (!ticket.assigned_at) {
        // Первое назначение — фиксируем dueAt по текущему SLA-порогу
        // приоритета; при последующих переназначениях due_at не двигаем
        // (SLA считается от факта аварии, не от смены исполнителя).
        updates.assigned_at = new Date().toISOString().replace("T", " ").slice(0, 19);
        const slaHours = getSlaHours(req.params.id, ticket.priority);
        const due = new Date(Date.now() + slaHours * 3600 * 1000);
        updates.due_at = due.toISOString().replace("T", " ").slice(0, 19);
      }
      if (ticket.status === "new") updates.status = "assigned";
      auditEvents.push({ action: "ticket.assign", details: { assignee: newAssignee } });
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "priority")) {
    if (!isAdmin) return res.status(403).json({ error: "forbidden", message: "Менять приоритет может только admin" });
    if (!PRIORITIES.includes(body.priority)) return res.status(400).json({ error: "invalid_priority" });
    updates.priority = body.priority;
  }

  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const newStatus = body.status;
    if (!STATUSES.includes(newStatus)) return res.status(400).json({ error: "invalid_status" });
    if (newStatus === "cancelled" && !isAdmin) {
      return res.status(403).json({ error: "forbidden", message: "Отменить тикет может только admin" });
    }
    if (!isAdmin && !isAssignee) {
      return res.status(403).json({ error: "forbidden", message: "Менять статус может исполнитель или admin" });
    }
    updates.status = newStatus;
    if (newStatus === "closed" || newStatus === "cancelled") {
      updates.closed_by = req.user.username;
      updates.closed_at = new Date().toISOString().replace("T", " ").slice(0, 19);
      updates.resolution_note = body.resolutionNote || null;
    } else if (["closed", "cancelled"].includes(ticket.status)) {
      // Admin переоткрывает ранее закрытый/отменённый тикет — старые
      // "закрыт кем/когда/итог" больше не актуальны для текущего статуса.
      updates.closed_by = null;
      updates.closed_at = null;
      updates.resolution_note = null;
    }
    auditEvents.push({ action: "ticket.status_change", details: { from: ticket.status, to: newStatus } });
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: "no_updates" });
  }

  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE tickets SET ${setClause} WHERE id = @id`).run({ ...updates, id: ticket.id });

  const updated = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
  for (const evt of auditEvents) {
    logAudit({
      actor: req.user.username, projectId: req.params.id, action: evt.action,
      entityType: "ticket", entityId: ticket.id, entityLabel: ticket.title, details: evt.details, ip: req.ip,
    });
    notifyTicketEvent({ type: evt.action === "ticket.assign" ? "assigned" : "status_change", ticket: updated, actor: req.user.username });
  }
  res.json({ ticket: serializeTicket(updated) });
});

router.post("/:id/tickets/:ticketId/comments", requireRole("editor", "admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const ticket = requireTicket(req, res);
  if (!ticket) return;
  const { body: text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "body_required" });
  }
  const info = db
    .prepare("INSERT INTO ticket_comments (ticket_id, author, body) VALUES (?, ?, ?)")
    .run(ticket.id, req.user.username, text.trim());
  const comment = db.prepare("SELECT * FROM ticket_comments WHERE id = ?").get(info.lastInsertRowid);
  logAudit({
    actor: req.user.username, projectId: req.params.id, action: "ticket.comment",
    entityType: "ticket", entityId: ticket.id, entityLabel: ticket.title, ip: req.ip,
  });
  notifyTicketEvent({ type: "comment", ticket, actor: req.user.username, comment: comment.body });
  res.status(201).json({ comment: serializeComment(comment) });
});

// Фото прикладывается как сырое тело запроса (как отчёты по фонарям) —
// имя файла и id комментария передаются query-параметрами, а не в JSON,
// иначе пришлось бы кодировать бинарные данные в base64 внутри тела.
const ATTACHMENT_LIMIT = "15mb";
const attachmentParser = express.raw({ type: () => true, limit: ATTACHMENT_LIMIT });

router.post("/:id/tickets/:ticketId/attachments", requireRole("editor", "admin"), attachmentParser, (req, res) => {
  if (!requireProject(req, res)) return;
  const ticket = requireTicket(req, res);
  if (!ticket) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: "empty_file" });
  }
  const filename = typeof req.query.filename === "string" ? req.query.filename : "photo";
  const commentId = req.query.commentId ? parseInt(req.query.commentId, 10) : null;
  if (commentId) {
    const comment = db.prepare("SELECT id FROM ticket_comments WHERE id = ? AND ticket_id = ?").get(commentId, ticket.id);
    if (!comment) return res.status(400).json({ error: "invalid_comment_id" });
  }
  const mimeType = req.headers["content-type"] || "application/octet-stream";

  const info = db
    .prepare(
      `INSERT INTO ticket_attachments (ticket_id, comment_id, filename, mime_type, size, data, uploaded_by)
       VALUES (@ticketId, @commentId, @filename, @mimeType, @size, @data, @uploadedBy)`
    )
    .run({
      ticketId: ticket.id, commentId, filename, mimeType,
      size: req.body.length, data: req.body, uploadedBy: req.user.username,
    });

  const row = db
    .prepare("SELECT id, ticket_id, comment_id, filename, mime_type, size, uploaded_by, created_at FROM ticket_attachments WHERE id = ?")
    .get(info.lastInsertRowid);
  res.status(201).json({ attachment: serializeAttachment(row) });
});

router.get("/:id/tickets/:ticketId/attachments/:attachmentId", (req, res) => {
  if (!requireProject(req, res)) return;
  const ticket = requireTicket(req, res);
  if (!ticket) return;
  const row = db
    .prepare("SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?")
    .get(req.params.attachmentId, ticket.id);
  if (!row) return res.status(404).json({ error: "attachment_not_found" });
  res.set("Content-Type", row.mime_type || "application/octet-stream");
  res.send(row.data);
});

module.exports = router;
