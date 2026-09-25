/*
Справочники объектов (см. db.js: attribute_definitions/equipment_profiles/
equipment_profile_attributes/cable_types) — общие на всю систему, не
per-project. Сама модель шахты (project_state.snapshot_json) не трогается:
оборудование получит поле profileId отдельным шагом (см. обсуждение), здесь —
только CRUD над самими справочниками.

Шаг 1 из плана: только справочник, без интеграции в редактор — index.html
пока продолжает работать со своими захардкоженными CABLE_TYPES/EQUIP_SHAPE_*,
никакого изменения поведения для существующих проектов.

key атрибута/типа кабеля и id профиля неизменяемы после создания — они
используются как литеральные значения внутри уже сохранённых снапшотов
(equipment.cableType, raw_metrics_json) и переименование задним числом
рассинхронило бы историю. Удаление блокируется, если справочник ещё
где-то используется — единственный способ проверить это для оборудования/
кабелей внутри project_state.snapshot_json это пройтись по всем проектам
(их не тысячи, полное сканирование не проблема).
*/
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");

const router = express.Router();

// Лёгкий read-only эндпоинт — доступен любой авторизованной роли (не только
// admin), в отличие от остального CRUD ниже: панель "Инфо" в редакторе
// показывает человекочитаемые названия/единицы метрик всем, кто открыл
// проект (см. index.html metricsRowsHtml), а не только админам. Определён
// до router.use(requireRole("admin")) ниже, чтобы не попасть под общий гейт.
router.get("/attributes/public", requireAuth, (req, res) => {
  const attrs = db
    .prepare("SELECT key, label, data_type AS dataType, unit FROM attribute_definitions ORDER BY group_name, label")
    .all();
  res.json({ attributes: attrs });
});

// Типы кабелей нужны редактору для отрисовки трасс (цвет/толщина/тип линии
// выпадающего списка при создании кабеля) — тоже любой авторизованной роли,
// не только admin (см. загрузку CABLE_TYPES в index.html).
router.get("/cable-types/public", requireAuth, (req, res) => {
  const types = db
    .prepare("SELECT key, label, color, thickness, line_type AS lineType FROM cable_types ORDER BY sort_order")
    .all();
  res.json({ cableTypes: types });
});

// Формы оборудования — аналогично, нужны редактору для выпадающего списка
// при создании оборудования (см. загрузку EQUIP_SHAPE_* в index.html).
router.get("/equipment-shapes/public", requireAuth, (req, res) => {
  const shapes = db
    .prepare(
      "SELECT key, label, default_color AS defaultColor, geometry, monitorable, selectable, diagram_shape AS diagramShape FROM equipment_shapes ORDER BY sort_order"
    )
    .all()
    .map((s) => ({ ...s, monitorable: !!s.monitorable, selectable: !!s.selectable }));
  res.json({ shapes });
});

// Системы мониторинга (ВОЛС/LFC/АО/...) и их связи с типами кабелей/формами
// оборудования — нужны странице "Мониторинг" (кнопки-фильтры системы + какие
// слои показывать/скрывать, см. MONITOR_SYSTEMS/CABLE_TYPE_SYSTEMS/
// EQUIP_SHAPE_SYSTEMS в index.html), любой авторизованной роли.
router.get("/monitor-systems/public", requireAuth, (req, res) => {
  const systems = db.prepare("SELECT key FROM monitor_systems ORDER BY sort_order").all().map((r) => r.key);
  const cableTypeSystems = {};
  for (const row of db.prepare("SELECT cable_type_key, system_key FROM cable_type_systems").all()) {
    (cableTypeSystems[row.cable_type_key] ||= []).push(row.system_key);
  }
  const equipmentShapeSystems = {};
  for (const row of db.prepare("SELECT shape_key, system_key FROM equipment_shape_systems").all()) {
    (equipmentShapeSystems[row.shape_key] ||= []).push(row.system_key);
  }
  res.json({ systems, cableTypeSystems, equipmentShapeSystems });
});

// Профили оборудования + профиль формы по умолчанию — нужны редактору
// (выпадающий список "Профиль" на объекте, детектор "должно быть, но не
// пришло" в карточке "Инфо") любой авторизованной роли, не только admin.
router.get("/equipment-profiles/public", requireAuth, (req, res) => {
  const profiles = db.prepare("SELECT id, name FROM equipment_profiles ORDER BY name").all();
  const attrRows = db
    .prepare(
      `SELECT epa.profile_id AS profileId, epa.attribute_key AS attributeKey, ad.label, ad.unit
       FROM equipment_profile_attributes epa
       JOIN attribute_definitions ad ON ad.key = epa.attribute_key
       ORDER BY epa.profile_id, epa.sort_order`
    )
    .all();
  const shapeDefaults = {};
  for (const row of db.prepare("SELECT shape, profile_id AS profileId FROM shape_default_profiles").all()) {
    shapeDefaults[row.shape] = row.profileId;
  }
  res.json({
    profiles: profiles.map((p) => ({
      ...p,
      attributes: attrRows.filter((a) => a.profileId === p.id).map((a) => ({ key: a.attributeKey, label: a.label, unit: a.unit })),
    })),
    shapeDefaults,
  });
});

router.use(requireAuth, requireRole("admin"));

const DATA_TYPES = new Set(["number", "boolean", "string"]);
const LINE_TYPES = new Set(["solid", "dashed", "dotted"]);
const GEOMETRY_TYPES = new Set(["sphere", "box", "cylinder", "cone", "capsule", "disc"]);
const DIAGRAM_SHAPE_TYPES = new Set(["circle", "rect", "hexagon", "triangle", "diamond"]);
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

// Раньше countEquipmentUsingProfile/Shape/countCablesUsingType каждая сама
// по себе делала полный SELECT snapshot_json + JSON.parse по ВСЕМ проектам
// — а список справочника вызывает такую функцию на каждую свою строку
// (usage-колонка), то есть на 20 форм оборудования — 20 полных сканирований
// всех снапшотов всех проектов на один GET. На реальных снапшотах
// (не тестовых, в пару килобайт) это и давало по минуте зависания страницы
// /references. Теперь один проход по project_state считает счётчики сразу
// для всех ключей всех трёх справочников — list-эндпоинты передают эти
// заранее посчитанные карты, а не пересканируют per-item; функции с
// единичным ключом (нужны только DELETE-обработчикам, где по-другому
// нельзя — проверяем один конкретный ключ) остаются по одному скану, как
// раньше, но это уже не на каждую строку списка, а один раз на запрос.
function scanSnapshotUsage() {
  const rows = db.prepare("SELECT snapshot_json FROM project_state").all();
  const profileCounts = new Map();
  const shapeCounts = new Map();
  const cableTypeCounts = new Map();
  const bump = (map, key) => {
    if (key == null) return;
    map.set(key, (map.get(key) || 0) + 1);
  };
  for (const row of rows) {
    let snap;
    try {
      snap = JSON.parse(row.snapshot_json);
    } catch (e) {
      continue;
    }
    for (const eq of snap.equipment || []) {
      bump(profileCounts, eq.profileId);
      bump(shapeCounts, eq.shape);
    }
    for (const c of snap.cables || []) {
      bump(cableTypeCounts, c.cableType);
    }
  }
  return { profileCounts, shapeCounts, cableTypeCounts };
}

function countEquipmentUsingProfile(profileId) {
  return scanSnapshotUsage().profileCounts.get(profileId) || 0;
}

function countEquipmentUsingShape(shapeKey) {
  return scanSnapshotUsage().shapeCounts.get(shapeKey) || 0;
}

function countCablesUsingType(cableTypeKey) {
  return scanSnapshotUsage().cableTypeCounts.get(cableTypeKey) || 0;
}

/* ================= Атрибуты ================= */

router.get("/attributes", (req, res) => {
  const attrs = db
    .prepare("SELECT key, label, data_type AS dataType, unit, group_name AS groupName FROM attribute_definitions ORDER BY group_name, label")
    .all();
  res.json({ attributes: attrs });
});

router.post("/attributes", (req, res) => {
  const { key, label, dataType, unit, groupName } = req.body || {};
  if (!key || !KEY_RE.test(key)) return res.status(400).json({ error: "invalid_key" });
  if (!label || !String(label).trim()) return res.status(400).json({ error: "missing_label" });
  if (!DATA_TYPES.has(dataType)) return res.status(400).json({ error: "invalid_data_type" });
  if (!groupName || !String(groupName).trim()) return res.status(400).json({ error: "missing_group" });
  const exists = db.prepare("SELECT 1 FROM attribute_definitions WHERE key = ?").get(key);
  if (exists) return res.status(409).json({ error: "already_exists" });
  db.prepare(
    "INSERT INTO attribute_definitions (key, label, data_type, unit, group_name) VALUES (?, ?, ?, ?, ?)"
  ).run(key, label.trim(), dataType, unit ? String(unit).trim() : null, groupName.trim());
  logAudit({ actor: req.user.username, action: "attribute.create", entityType: "attribute", entityId: key, entityLabel: label, ip: req.ip });
  res.status(201).json({ ok: true });
});

router.patch("/attributes/:key", (req, res) => {
  const { key } = req.params;
  const existing = db.prepare("SELECT * FROM attribute_definitions WHERE key = ?").get(key);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const { label, dataType, unit, groupName } = req.body || {};
  const next = {
    label: label !== undefined ? String(label).trim() : existing.label,
    dataType: dataType !== undefined ? dataType : existing.data_type,
    unit: unit !== undefined ? (unit ? String(unit).trim() : null) : existing.unit,
    groupName: groupName !== undefined ? String(groupName).trim() : existing.group_name,
  };
  if (!next.label) return res.status(400).json({ error: "missing_label" });
  if (!DATA_TYPES.has(next.dataType)) return res.status(400).json({ error: "invalid_data_type" });
  if (!next.groupName) return res.status(400).json({ error: "missing_group" });
  db.prepare(
    "UPDATE attribute_definitions SET label = ?, data_type = ?, unit = ?, group_name = ? WHERE key = ?"
  ).run(next.label, next.dataType, next.unit, next.groupName, key);
  logAudit({ actor: req.user.username, action: "attribute.update", entityType: "attribute", entityId: key, entityLabel: next.label, details: next, ip: req.ip });
  res.json({ ok: true });
});

router.delete("/attributes/:key", (req, res) => {
  const { key } = req.params;
  const usedByProfile = db
    .prepare("SELECT profile_id FROM equipment_profile_attributes WHERE attribute_key = ? LIMIT 1")
    .get(key);
  if (usedByProfile) return res.status(409).json({ error: "in_use", detail: "attribute_in_profile" });
  const result = db.prepare("DELETE FROM attribute_definitions WHERE key = ?").run(key);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  logAudit({ actor: req.user.username, action: "attribute.delete", entityType: "attribute", entityId: key, ip: req.ip });
  res.json({ ok: true });
});

/* ================= Профили оборудования ================= */

function loadProfiles() {
  const profiles = db.prepare("SELECT id, name FROM equipment_profiles ORDER BY name").all();
  const attrRows = db
    .prepare(
      `SELECT epa.profile_id AS profileId, epa.attribute_key AS attributeKey, epa.sort_order AS sortOrder
       FROM equipment_profile_attributes epa ORDER BY epa.profile_id, epa.sort_order`
    )
    .all();
  const { profileCounts } = scanSnapshotUsage();
  return profiles.map((p) => ({
    ...p,
    attributes: attrRows.filter((a) => a.profileId === p.id).map((a) => a.attributeKey),
    usage: profileCounts.get(p.id) || 0,
  }));
}

router.get("/equipment-profiles", (req, res) => {
  res.json({ profiles: loadProfiles() });
});

router.post("/equipment-profiles", (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "missing_name" });
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO equipment_profiles (id, name) VALUES (?, ?)").run(id, name.trim());
  logAudit({ actor: req.user.username, action: "equipment_profile.create", entityType: "equipment_profile", entityId: id, entityLabel: name, ip: req.ip });
  res.status(201).json({ id });
});

router.patch("/equipment-profiles/:id", (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "missing_name" });
  const result = db.prepare("UPDATE equipment_profiles SET name = ? WHERE id = ?").run(name.trim(), id);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  logAudit({ actor: req.user.username, action: "equipment_profile.update", entityType: "equipment_profile", entityId: id, entityLabel: name, ip: req.ip });
  res.json({ ok: true });
});

router.delete("/equipment-profiles/:id", (req, res) => {
  const { id } = req.params;
  const usage = countEquipmentUsingProfile(id);
  if (usage > 0) return res.status(409).json({ error: "in_use", detail: "profile_assigned_to_equipment", count: usage });
  db.prepare("DELETE FROM equipment_profile_attributes WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM shape_default_profiles WHERE profile_id = ?").run(id);
  const result = db.prepare("DELETE FROM equipment_profiles WHERE id = ?").run(id);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  logAudit({ actor: req.user.username, action: "equipment_profile.delete", entityType: "equipment_profile", entityId: id, ip: req.ip });
  res.json({ ok: true });
});

router.post("/equipment-profiles/:id/attributes", (req, res) => {
  const { id } = req.params;
  const { attributeKey } = req.body || {};
  const profile = db.prepare("SELECT 1 FROM equipment_profiles WHERE id = ?").get(id);
  if (!profile) return res.status(404).json({ error: "not_found" });
  const attr = db.prepare("SELECT 1 FROM attribute_definitions WHERE key = ?").get(attributeKey);
  if (!attr) return res.status(400).json({ error: "unknown_attribute" });
  const already = db
    .prepare("SELECT 1 FROM equipment_profile_attributes WHERE profile_id = ? AND attribute_key = ?")
    .get(id, attributeKey);
  if (already) return res.status(409).json({ error: "already_added" });
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM equipment_profile_attributes WHERE profile_id = ?")
    .get(id).m;
  db.prepare(
    "INSERT INTO equipment_profile_attributes (profile_id, attribute_key, sort_order) VALUES (?, ?, ?)"
  ).run(id, attributeKey, maxOrder + 1);
  logAudit({ actor: req.user.username, action: "equipment_profile.add_attribute", entityType: "equipment_profile", entityId: id, details: { attributeKey }, ip: req.ip });
  res.status(201).json({ ok: true });
});

router.delete("/equipment-profiles/:id/attributes/:attributeKey", (req, res) => {
  const { id, attributeKey } = req.params;
  const result = db
    .prepare("DELETE FROM equipment_profile_attributes WHERE profile_id = ? AND attribute_key = ?")
    .run(id, attributeKey);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  logAudit({ actor: req.user.username, action: "equipment_profile.remove_attribute", entityType: "equipment_profile", entityId: id, details: { attributeKey }, ip: req.ip });
  res.json({ ok: true });
});

// Профиль по умолчанию на форму оборудования — раньше существовал только
// как строки, посаженные вручную сидом в db.js (isib/iilb), без всякого
// UI для остальных форм и без способа поменять уже заданное. shape —
// PRIMARY KEY таблицы, поэтому один PUT либо ставит (profileId задан),
// либо снимает (profileId: null) дефолт для формы, GET отдаёт всё разом.
router.get("/shape-default-profiles", (req, res) => {
  const rows = db.prepare("SELECT shape, profile_id AS profileId FROM shape_default_profiles").all();
  res.json({ shapeDefaults: rows });
});

router.put("/shape-default-profiles/:shape", (req, res) => {
  const { shape } = req.params;
  const { profileId } = req.body || {};
  const shapeExists = db.prepare("SELECT 1 FROM equipment_shapes WHERE key = ?").get(shape);
  if (!shapeExists) return res.status(404).json({ error: "unknown_shape" });

  if (profileId === null || profileId === undefined || profileId === "") {
    db.prepare("DELETE FROM shape_default_profiles WHERE shape = ?").run(shape);
    logAudit({ actor: req.user.username, action: "shape_default_profile.clear", entityType: "equipment_shape", entityId: shape, ip: req.ip });
    return res.json({ ok: true, profileId: null });
  }

  const profileExists = db.prepare("SELECT 1 FROM equipment_profiles WHERE id = ?").get(profileId);
  if (!profileExists) return res.status(400).json({ error: "unknown_profile" });
  db.prepare(
    `INSERT INTO shape_default_profiles (shape, profile_id) VALUES (?, ?)
     ON CONFLICT(shape) DO UPDATE SET profile_id = excluded.profile_id`
  ).run(shape, profileId);
  logAudit({ actor: req.user.username, action: "shape_default_profile.set", entityType: "equipment_shape", entityId: shape, details: { profileId }, ip: req.ip });
  res.json({ ok: true, profileId });
});

/* ================= Типы кабелей ================= */

function getSystemsFor(table, column, key) {
  return db.prepare(`SELECT system_key FROM ${table} WHERE ${column} = ?`).all(key).map((r) => r.system_key);
}

router.get("/cable-types", (req, res) => {
  const { cableTypeCounts } = scanSnapshotUsage();
  const types = db
    .prepare(
      "SELECT key, label, color, thickness, line_type AS lineType, sort_order AS sortOrder FROM cable_types ORDER BY sort_order"
    )
    .all()
    .map((t) => ({ ...t, usage: cableTypeCounts.get(t.key) || 0, systems: getSystemsFor("cable_type_systems", "cable_type_key", t.key) }));
  res.json({ cableTypes: types });
});

router.post("/cable-types", (req, res) => {
  const { key, label, color, thickness, lineType } = req.body || {};
  if (!key || !KEY_RE.test(key)) return res.status(400).json({ error: "invalid_key" });
  if (!label || !String(label).trim()) return res.status(400).json({ error: "missing_label" });
  if (!/^#[0-9a-fA-F]{6}$/.test(color || "")) return res.status(400).json({ error: "invalid_color" });
  const t = Number(thickness);
  if (!Number.isFinite(t) || t <= 0) return res.status(400).json({ error: "invalid_thickness" });
  if (!LINE_TYPES.has(lineType)) return res.status(400).json({ error: "invalid_line_type" });
  const exists = db.prepare("SELECT 1 FROM cable_types WHERE key = ?").get(key);
  if (exists) return res.status(409).json({ error: "already_exists" });
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM cable_types").get().m;
  db.prepare(
    "INSERT INTO cable_types (key, label, color, thickness, line_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, label.trim(), color, t, lineType, maxOrder + 1);
  logAudit({ actor: req.user.username, action: "cable_type.create", entityType: "cable_type", entityId: key, entityLabel: label, ip: req.ip });
  res.status(201).json({ ok: true });
});

router.patch("/cable-types/:key", (req, res) => {
  const { key } = req.params;
  const existing = db.prepare("SELECT * FROM cable_types WHERE key = ?").get(key);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const { label, color, thickness, lineType } = req.body || {};
  const next = {
    label: label !== undefined ? String(label).trim() : existing.label,
    color: color !== undefined ? color : existing.color,
    thickness: thickness !== undefined ? Number(thickness) : existing.thickness,
    lineType: lineType !== undefined ? lineType : existing.line_type,
  };
  if (!next.label) return res.status(400).json({ error: "missing_label" });
  if (!/^#[0-9a-fA-F]{6}$/.test(next.color || "")) return res.status(400).json({ error: "invalid_color" });
  if (!Number.isFinite(next.thickness) || next.thickness <= 0) return res.status(400).json({ error: "invalid_thickness" });
  if (!LINE_TYPES.has(next.lineType)) return res.status(400).json({ error: "invalid_line_type" });
  db.prepare(
    "UPDATE cable_types SET label = ?, color = ?, thickness = ?, line_type = ? WHERE key = ?"
  ).run(next.label, next.color, next.thickness, next.lineType, key);
  logAudit({ actor: req.user.username, action: "cable_type.update", entityType: "cable_type", entityId: key, entityLabel: next.label, details: next, ip: req.ip });
  res.json({ ok: true });
});

router.delete("/cable-types/:key", (req, res) => {
  const { key } = req.params;
  const usage = countCablesUsingType(key);
  if (usage > 0) return res.status(409).json({ error: "in_use", detail: "cable_type_assigned_to_cables", count: usage });
  const result = db.prepare("DELETE FROM cable_types WHERE key = ?").run(key);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM cable_type_systems WHERE cable_type_key = ?").run(key);
  logAudit({ actor: req.user.username, action: "cable_type.delete", entityType: "cable_type", entityId: key, ip: req.ip });
  res.json({ ok: true });
});

/* ================= Формы оборудования ================= */

router.get("/equipment-shapes", (req, res) => {
  const { shapeCounts } = scanSnapshotUsage();
  const shapes = db
    .prepare(
      "SELECT key, label, default_color AS defaultColor, geometry, monitorable, selectable, diagram_shape AS diagramShape, sort_order AS sortOrder FROM equipment_shapes ORDER BY sort_order"
    )
    .all()
    .map((s) => ({
      ...s,
      monitorable: !!s.monitorable,
      selectable: !!s.selectable,
      usage: shapeCounts.get(s.key) || 0,
      systems: getSystemsFor("equipment_shape_systems", "shape_key", s.key),
    }));
  res.json({ shapes });
});

router.post("/equipment-shapes", (req, res) => {
  const { key, label, defaultColor, geometry, monitorable, selectable, diagramShape } = req.body || {};
  if (!key || !KEY_RE.test(key)) return res.status(400).json({ error: "invalid_key" });
  if (!label || !String(label).trim()) return res.status(400).json({ error: "missing_label" });
  if (defaultColor != null && !/^#[0-9a-fA-F]{6}$/.test(defaultColor)) return res.status(400).json({ error: "invalid_color" });
  const geom = geometry || "sphere";
  if (!GEOMETRY_TYPES.has(geom)) return res.status(400).json({ error: "invalid_geometry" });
  const diagShape = diagramShape || "circle";
  if (!DIAGRAM_SHAPE_TYPES.has(diagShape)) return res.status(400).json({ error: "invalid_diagram_shape" });
  const exists = db.prepare("SELECT 1 FROM equipment_shapes WHERE key = ?").get(key);
  if (exists) return res.status(409).json({ error: "already_exists" });
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM equipment_shapes").get().m;
  db.prepare(
    "INSERT INTO equipment_shapes (key, label, default_color, geometry, monitorable, selectable, diagram_shape, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(key, label.trim(), defaultColor ?? null, geom, monitorable ? 1 : 0, selectable === false ? 0 : 1, diagShape, maxOrder + 1);
  logAudit({ actor: req.user.username, action: "equipment_shape.create", entityType: "equipment_shape", entityId: key, entityLabel: label, ip: req.ip });
  res.status(201).json({ ok: true });
});

router.patch("/equipment-shapes/:key", (req, res) => {
  const { key } = req.params;
  const existing = db.prepare("SELECT * FROM equipment_shapes WHERE key = ?").get(key);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const { label, defaultColor, geometry, monitorable, selectable, diagramShape } = req.body || {};
  const next = {
    label: label !== undefined ? String(label).trim() : existing.label,
    defaultColor: defaultColor !== undefined ? defaultColor : existing.default_color,
    geometry: geometry !== undefined ? geometry : existing.geometry,
    monitorable: monitorable !== undefined ? (monitorable ? 1 : 0) : existing.monitorable,
    selectable: selectable !== undefined ? (selectable ? 1 : 0) : existing.selectable,
    diagramShape: diagramShape !== undefined ? diagramShape : existing.diagram_shape,
  };
  if (!next.label) return res.status(400).json({ error: "missing_label" });
  if (next.defaultColor != null && !/^#[0-9a-fA-F]{6}$/.test(next.defaultColor)) return res.status(400).json({ error: "invalid_color" });
  if (!GEOMETRY_TYPES.has(next.geometry)) return res.status(400).json({ error: "invalid_geometry" });
  if (!DIAGRAM_SHAPE_TYPES.has(next.diagramShape)) return res.status(400).json({ error: "invalid_diagram_shape" });
  db.prepare(
    "UPDATE equipment_shapes SET label = ?, default_color = ?, geometry = ?, monitorable = ?, selectable = ?, diagram_shape = ? WHERE key = ?"
  ).run(next.label, next.defaultColor, next.geometry, next.monitorable, next.selectable, next.diagramShape, key);
  logAudit({ actor: req.user.username, action: "equipment_shape.update", entityType: "equipment_shape", entityId: key, entityLabel: next.label, details: next, ip: req.ip });
  res.json({ ok: true });
});

router.delete("/equipment-shapes/:key", (req, res) => {
  const { key } = req.params;
  const usage = countEquipmentUsingShape(key);
  if (usage > 0) return res.status(409).json({ error: "in_use", detail: "shape_assigned_to_equipment", count: usage });
  const result = db.prepare("DELETE FROM equipment_shapes WHERE key = ?").run(key);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM equipment_shape_systems WHERE shape_key = ?").run(key);
  logAudit({ actor: req.user.username, action: "equipment_shape.delete", entityType: "equipment_shape", entityId: key, ip: req.ip });
  res.json({ ok: true });
});

/* ================= Системы мониторинга ================= */
// key = отображаемое название (как и было в хардкоде MONITOR_SYSTEMS) —
// отдельного человекочитаемого label не заводим, сущностей всего 5.

router.get("/monitor-systems", (req, res) => {
  const systems = db
    .prepare("SELECT key, sort_order AS sortOrder FROM monitor_systems ORDER BY sort_order")
    .all()
    .map((s) => ({
      ...s,
      cableTypeUsage: db.prepare("SELECT COUNT(*) AS n FROM cable_type_systems WHERE system_key = ?").get(s.key).n,
      shapeUsage: db.prepare("SELECT COUNT(*) AS n FROM equipment_shape_systems WHERE system_key = ?").get(s.key).n,
    }));
  res.json({ systems });
});

router.post("/monitor-systems", (req, res) => {
  const { key } = req.body || {};
  if (!key || !String(key).trim()) return res.status(400).json({ error: "missing_label" });
  const trimmedKey = String(key).trim();
  const exists = db.prepare("SELECT 1 FROM monitor_systems WHERE key = ?").get(trimmedKey);
  if (exists) return res.status(409).json({ error: "already_exists" });
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM monitor_systems").get().m;
  db.prepare("INSERT INTO monitor_systems (key, sort_order) VALUES (?, ?)").run(trimmedKey, maxOrder + 1);
  logAudit({ actor: req.user.username, action: "monitor_system.create", entityType: "monitor_system", entityId: trimmedKey, ip: req.ip });
  res.status(201).json({ ok: true });
});

router.delete("/monitor-systems/:key", (req, res) => {
  const { key } = req.params;
  const cableUsage = db.prepare("SELECT COUNT(*) AS n FROM cable_type_systems WHERE system_key = ?").get(key).n;
  const shapeUsage = db.prepare("SELECT COUNT(*) AS n FROM equipment_shape_systems WHERE system_key = ?").get(key).n;
  if (cableUsage > 0 || shapeUsage > 0) {
    return res.status(409).json({ error: "in_use", detail: "system_assigned_to_types", count: cableUsage + shapeUsage });
  }
  const result = db.prepare("DELETE FROM monitor_systems WHERE key = ?").run(key);
  if (!result.changes) return res.status(404).json({ error: "not_found" });
  logAudit({ actor: req.user.username, action: "monitor_system.delete", entityType: "monitor_system", entityId: key, ip: req.ip });
  res.json({ ok: true });
});

// Связи типа кабеля/формы оборудования с системами — заменяем набор целиком
// (проще для чекбокс-матрицы в UI, чем эндпоинты на каждую пару отдельно).
router.put("/cable-types/:key/systems", (req, res) => {
  const { key } = req.params;
  const exists = db.prepare("SELECT 1 FROM cable_types WHERE key = ?").get(key);
  if (!exists) return res.status(404).json({ error: "not_found" });
  const systems = Array.isArray(req.body?.systems) ? req.body.systems : [];
  const validSystems = new Set(db.prepare("SELECT key FROM monitor_systems").all().map((s) => s.key));
  for (const s of systems) {
    if (!validSystems.has(s)) return res.status(400).json({ error: "invalid_system", detail: s });
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM cable_type_systems WHERE cable_type_key = ?").run(key);
    const insert = db.prepare("INSERT INTO cable_type_systems (cable_type_key, system_key) VALUES (?, ?)");
    for (const s of systems) insert.run(key, s);
  });
  tx();
  logAudit({ actor: req.user.username, action: "cable_type.set_systems", entityType: "cable_type", entityId: key, details: { systems }, ip: req.ip });
  res.json({ ok: true });
});

router.put("/equipment-shapes/:key/systems", (req, res) => {
  const { key } = req.params;
  const exists = db.prepare("SELECT 1 FROM equipment_shapes WHERE key = ?").get(key);
  if (!exists) return res.status(404).json({ error: "not_found" });
  const systems = Array.isArray(req.body?.systems) ? req.body.systems : [];
  const validSystems = new Set(db.prepare("SELECT key FROM monitor_systems").all().map((s) => s.key));
  for (const s of systems) {
    if (!validSystems.has(s)) return res.status(400).json({ error: "invalid_system", detail: s });
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM equipment_shape_systems WHERE shape_key = ?").run(key);
    const insert = db.prepare("INSERT INTO equipment_shape_systems (shape_key, system_key) VALUES (?, ?)");
    for (const s of systems) insert.run(key, s);
  });
  tx();
  logAudit({ actor: req.user.username, action: "equipment_shape.set_systems", entityType: "equipment_shape", entityId: key, details: { systems }, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
