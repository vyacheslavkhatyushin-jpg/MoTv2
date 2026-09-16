/*
Единый журнал действий (см. audit_log в db.js) — вызывается из роутов сразу
после того, как изменение реально применилось (не раньше, чтобы не
залогировать действие, которое потом отклонено валидацией/конфликтом).
*/
const db = require("../db");

const stmt = db.prepare(
  `INSERT INTO audit_log (actor, project_id, action, entity_type, entity_id, entity_label, details, ip)
   VALUES (@actor, @projectId, @action, @entityType, @entityId, @entityLabel, @details, @ip)`
);

function logAudit({ actor, projectId, action, entityType, entityId, entityLabel, details, ip }) {
  stmt.run({
    actor,
    projectId: projectId || null,
    action,
    entityType: entityType || null,
    entityId: entityId != null ? String(entityId) : null,
    entityLabel: entityLabel || null,
    details: details !== undefined ? JSON.stringify(details) : null,
    ip: ip || null,
  });
}

module.exports = { logAudit };
