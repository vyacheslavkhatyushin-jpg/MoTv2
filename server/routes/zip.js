/*
Реестр ЗИП (склад запчастей) + заявки на выдачу. Отдельный модуль от
3D-модели шахты — никакой связи с cables/equipment/marks, свои таблицы
(см. server/db.js). ЗИП только расходуется, возврата на склад нет.

Роли: смотреть каталог/свои заявки может любой авторизованный (viewer
и выше); подавать заявку — editor/admin; управлять каталогом (создавать
позиции, оформлять приход, корректировки) и решать по заявкам
(одобрить/отклонить/выдать) — только admin.
*/
const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");

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

function serializeItem(row) {
  return {
    id: row.id, name: row.name, category: row.category, unit: row.unit,
    manufacturer: row.manufacturer, partNumber: row.part_number, description: row.description,
    location: row.location, minQty: row.min_qty,
    qtyOnHand: row.qty_on_hand, qtyReserved: row.qty_reserved,
    qtyAvailable: row.qty_on_hand - row.qty_reserved,
    lowStock: row.qty_on_hand - row.qty_reserved < row.min_qty,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

/* ---------- каталог ---------- */
router.get("/:id/zip/items", (req, res) => {
  if (!requireProject(req, res)) return;
  const rows = db.prepare("SELECT * FROM zip_items WHERE project_id = ? ORDER BY name").all(req.params.id);
  res.json({ items: rows.map(serializeItem) });
});

router.post("/:id/zip/items", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const { name, category, unit, manufacturer, partNumber, description, location, minQty } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "missing_name" });
  const id = "zip_" + crypto.randomUUID();
  db.prepare(
    `INSERT INTO zip_items (id, project_id, name, category, unit, manufacturer, part_number, description, location, min_qty, created_by)
     VALUES (@id, @projectId, @name, @category, @unit, @manufacturer, @partNumber, @description, @location, @minQty, @createdBy)`
  ).run({
    id, projectId: req.params.id, name: name.trim(),
    category: category || null, unit: (unit || "шт").trim(), manufacturer: manufacturer || null,
    partNumber: partNumber || null, description: description || null, location: location || null,
    minQty: Number.isFinite(minQty) ? minQty : 0, createdBy: req.user.username,
  });
  const row = db.prepare("SELECT * FROM zip_items WHERE id = ?").get(id);
  res.status(201).json({ item: serializeItem(row) });
});

router.put("/:id/zip/items/:itemId", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const row = db.prepare("SELECT * FROM zip_items WHERE id = ? AND project_id = ?").get(req.params.itemId, req.params.id);
  if (!row) return res.status(404).json({ error: "item_not_found" });
  const { name, category, unit, manufacturer, partNumber, description, location, minQty } = req.body || {};
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: "missing_name" });
  db.prepare(
    `UPDATE zip_items SET
       name = @name, category = @category, unit = @unit, manufacturer = @manufacturer,
       part_number = @partNumber, description = @description, location = @location, min_qty = @minQty
     WHERE id = @id`
  ).run({
    id: row.id,
    name: name !== undefined ? name.trim() : row.name,
    category: category !== undefined ? category : row.category,
    unit: unit !== undefined ? unit.trim() : row.unit,
    manufacturer: manufacturer !== undefined ? manufacturer : row.manufacturer,
    partNumber: partNumber !== undefined ? partNumber : row.part_number,
    description: description !== undefined ? description : row.description,
    location: location !== undefined ? location : row.location,
    minQty: Number.isFinite(minQty) ? minQty : row.min_qty,
  });
  const updated = db.prepare("SELECT * FROM zip_items WHERE id = ?").get(row.id);
  res.json({ item: serializeItem(updated) });
});

router.delete("/:id/zip/items/:itemId", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const row = db.prepare("SELECT id FROM zip_items WHERE id = ? AND project_id = ?").get(req.params.itemId, req.params.id);
  if (!row) return res.status(404).json({ error: "item_not_found" });
  db.prepare("DELETE FROM zip_items WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

/* ---------- приход / корректировка остатка ---------- */
const stmtGetItemForUpdate = db.prepare("SELECT * FROM zip_items WHERE id = ? AND project_id = ?");
const stmtBumpOnHand = db.prepare("UPDATE zip_items SET qty_on_hand = qty_on_hand + ? WHERE id = ?");
const stmtInsertMovement = db.prepare(
  `INSERT INTO zip_movements (project_id, item_id, delta, reason, request_id, note, created_by)
   VALUES (@projectId, @itemId, @delta, @reason, @requestId, @note, @createdBy)`
);

router.post("/:id/zip/items/:itemId/receipt", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const item = stmtGetItemForUpdate.get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: "item_not_found" });
  const qty = parseInt((req.body || {}).qty, 10);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "invalid_qty" });
  const note = (req.body || {}).note || null;
  db.transaction(() => {
    stmtBumpOnHand.run(qty, item.id);
    stmtInsertMovement.run({ projectId: req.params.id, itemId: item.id, delta: qty, reason: "receipt", requestId: null, note, createdBy: req.user.username });
  })();
  res.json({ item: serializeItem(stmtGetItemForUpdate.get(item.id, req.params.id)) });
});

router.post("/:id/zip/items/:itemId/adjust", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const item = stmtGetItemForUpdate.get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: "item_not_found" });
  const delta = parseInt((req.body || {}).delta, 10);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: "invalid_delta" });
  if (item.qty_on_hand + delta < 0) return res.status(400).json({ error: "would_go_negative" });
  const note = (req.body || {}).note || null;
  db.transaction(() => {
    stmtBumpOnHand.run(delta, item.id);
    stmtInsertMovement.run({ projectId: req.params.id, itemId: item.id, delta, reason: "adjustment", requestId: null, note, createdBy: req.user.username });
  })();
  res.json({ item: serializeItem(stmtGetItemForUpdate.get(item.id, req.params.id)) });
});

router.get("/:id/zip/movements", (req, res) => {
  if (!requireProject(req, res)) return;
  const itemId = req.query.itemId;
  const rows = itemId
    ? db.prepare("SELECT * FROM zip_movements WHERE project_id = ? AND item_id = ? ORDER BY created_at DESC, id DESC LIMIT 500").all(req.params.id, itemId)
    : db.prepare("SELECT * FROM zip_movements WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 500").all(req.params.id);
  res.json({
    movements: rows.map((r) => ({
      id: r.id, itemId: r.item_id, delta: r.delta, reason: r.reason, requestId: r.request_id,
      note: r.note, createdBy: r.created_by, createdAt: r.created_at,
    })),
  });
});

/* ---------- заявки ---------- */
function serializeRequest(r) {
  return {
    id: r.id, itemId: r.item_id, itemName: r.item_name, qty: r.qty, reason: r.reason, status: r.status,
    requestedBy: r.requested_by, requestedAt: r.requested_at,
    decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note,
    issuedBy: r.issued_by, issuedAt: r.issued_at,
  };
}
const REQUEST_SELECT = `
  SELECT zr.*, zi.name AS item_name FROM zip_requests zr
  JOIN zip_items zi ON zi.id = zr.item_id
  WHERE zr.project_id = ?`;

router.get("/:id/zip/requests", (req, res) => {
  if (!requireProject(req, res)) return;
  // viewer/editor видят только свои заявки, admin — все.
  const isAdmin = req.user.role === "admin";
  const rows = isAdmin
    ? db.prepare(REQUEST_SELECT + " ORDER BY zr.requested_at DESC, zr.id DESC").all(req.params.id)
    : db.prepare(REQUEST_SELECT + " AND zr.requested_by = ? ORDER BY zr.requested_at DESC, zr.id DESC").all(req.params.id, req.user.username);
  res.json({ requests: rows.map(serializeRequest) });
});

router.post("/:id/zip/requests", requireRole("editor", "admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const { itemId, reason } = req.body || {};
  const qty = parseInt((req.body || {}).qty, 10);
  const item = db.prepare("SELECT id FROM zip_items WHERE id = ? AND project_id = ?").get(itemId, req.params.id);
  if (!item) return res.status(400).json({ error: "invalid_item" });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "invalid_qty" });
  const info = db.prepare(
    `INSERT INTO zip_requests (project_id, item_id, qty, reason, requested_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(req.params.id, itemId, qty, reason || null, req.user.username);
  const row = db.prepare(REQUEST_SELECT + " AND zr.id = ?").get(req.params.id, info.lastInsertRowid);
  res.status(201).json({ request: serializeRequest(row) });
});

function getOwnRequest(req, res, allowedStatuses) {
  const row = db.prepare(REQUEST_SELECT + " AND zr.id = ?").get(req.params.id, req.params.reqId);
  if (!row) {
    res.status(404).json({ error: "request_not_found" });
    return null;
  }
  if (!allowedStatuses.includes(row.status)) {
    res.status(409).json({ error: "invalid_status", status: row.status });
    return null;
  }
  return row;
}

router.post("/:id/zip/requests/:reqId/approve", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const request = getOwnRequest(req, res, ["pending"]);
  if (!request) return;
  const item = db.prepare("SELECT * FROM zip_items WHERE id = ?").get(request.item_id);
  const available = item.qty_on_hand - item.qty_reserved;
  if (request.qty > available) {
    return res.status(409).json({ error: "insufficient_stock", available });
  }
  db.transaction(() => {
    db.prepare("UPDATE zip_items SET qty_reserved = qty_reserved + ? WHERE id = ?").run(request.qty, item.id);
    db.prepare(
      "UPDATE zip_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?"
    ).run(req.user.username, (req.body || {}).note || null, request.id);
  })();
  res.json({ request: serializeRequest(db.prepare(REQUEST_SELECT + " AND zr.id = ?").get(req.params.id, request.id)) });
});

router.post("/:id/zip/requests/:reqId/reject", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const request = getOwnRequest(req, res, ["pending"]);
  if (!request) return;
  db.prepare(
    "UPDATE zip_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?"
  ).run(req.user.username, (req.body || {}).note || null, request.id);
  res.json({ request: serializeRequest(db.prepare(REQUEST_SELECT + " AND zr.id = ?").get(req.params.id, request.id)) });
});

router.post("/:id/zip/requests/:reqId/cancel", requireRole("editor", "admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const request = getOwnRequest(req, res, ["pending", "approved"]);
  if (!request) return;
  // Инженер может отменить только свою заявку; admin — любую.
  if (req.user.role !== "admin" && request.requested_by !== req.user.username) {
    return res.status(403).json({ error: "forbidden" });
  }
  db.transaction(() => {
    if (request.status === "approved") {
      db.prepare("UPDATE zip_items SET qty_reserved = qty_reserved - ? WHERE id = ?").run(request.qty, request.item_id);
    }
    db.prepare("UPDATE zip_requests SET status = 'cancelled', decided_by = ?, decided_at = datetime('now') WHERE id = ?")
      .run(req.user.username, request.id);
  })();
  res.json({ request: serializeRequest(db.prepare(REQUEST_SELECT + " AND zr.id = ?").get(req.params.id, request.id)) });
});

router.post("/:id/zip/requests/:reqId/issue", requireRole("admin"), (req, res) => {
  if (!requireProject(req, res)) return;
  const request = getOwnRequest(req, res, ["approved"]);
  if (!request) return;
  db.transaction(() => {
    db.prepare("UPDATE zip_items SET qty_on_hand = qty_on_hand - ?, qty_reserved = qty_reserved - ? WHERE id = ?")
      .run(request.qty, request.qty, request.item_id);
    stmtInsertMovement.run({
      projectId: req.params.id, itemId: request.item_id, delta: -request.qty, reason: "issue",
      requestId: request.id, note: null, createdBy: req.user.username,
    });
    db.prepare("UPDATE zip_requests SET status = 'issued', issued_by = ?, issued_at = datetime('now') WHERE id = ?")
      .run(req.user.username, request.id);
  })();
  res.json({ request: serializeRequest(db.prepare(REQUEST_SELECT + " AND zr.id = ?").get(req.params.id, request.id)) });
});

module.exports = router;
