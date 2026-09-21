/*
Единый журнал действий — admin и supervisor (см. audit_log в db.js). Два
режима чтения: /summary для дашборда (счётчики + график по дням за период)
и / для табличного вида с фильтрами и пагинацией — дашборд проваливается
в таблицу с уже выставленными фильтрами по клику.
*/
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin", "supervisor"));

const RANGE_TO_SQL = {
  "24h": "-1 day",
  "7d": "-7 days",
  "30d": "-30 days",
};

function rangeSince(range) {
  const mod = RANGE_TO_SQL[range];
  return mod ? `datetime('now', '${mod}')` : null;
}

function buildWhere(query) {
  const clauses = [];
  const params = {};
  const since = rangeSince(query.range);
  if (since) {
    clauses.push(`created_at >= ${since}`);
  }
  if (query.actor) {
    clauses.push("actor = @actor");
    params.actor = query.actor;
  }
  if (query.action) {
    clauses.push("action = @action");
    params.action = query.action;
  }
  if (query.projectId) {
    clauses.push("project_id = @projectId");
    params.projectId = String(query.projectId).toLowerCase();
  }
  if (query.q) {
    clauses.push("(entity_label LIKE @q OR actor LIKE @q)");
    params.q = `%${query.q}%`;
  }
  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

function serializeRow(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor,
    projectId: r.project_id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    details: r.details ? JSON.parse(r.details) : null,
    ip: r.ip,
  };
}

router.get("/summary", (req, res) => {
  const { where, params } = buildWhere(req.query);
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log ${where}`).get(params).c;
  const distinctActors = db.prepare(`SELECT COUNT(DISTINCT actor) c FROM audit_log ${where}`).get(params).c;
  const failedLogins = db.prepare(
    `SELECT COUNT(*) c FROM audit_log ${where}${where ? " AND" : "WHERE"} action = 'login.failed'`
  ).get(params).c;
  const byAction = db.prepare(
    `SELECT action, COUNT(*) c FROM audit_log ${where} GROUP BY action ORDER BY c DESC LIMIT 10`
  ).all(params);
  const topActors = db.prepare(
    `SELECT actor, COUNT(*) c FROM audit_log ${where} GROUP BY actor ORDER BY c DESC LIMIT 10`
  ).all(params);
  // По дням — всегда за фактическое окно диапазона (не безграничное "all"),
  // иначе график по всей истории проекта малополезен визуально.
  const byDayRange = req.query.range && RANGE_TO_SQL[req.query.range] ? req.query.range : "7d";
  const { where: dayWhere, params: dayParams } = buildWhere(Object.assign({}, req.query, { range: byDayRange }));
  const byDay = db.prepare(
    `SELECT date(created_at) AS day, COUNT(*) c FROM audit_log ${dayWhere} GROUP BY day ORDER BY day`
  ).all(dayParams);

  res.json({
    total,
    distinctActors,
    failedLogins,
    byAction: byAction.map((r) => ({ action: r.action, count: r.c })),
    topActors: topActors.map((r) => ({ actor: r.actor, count: r.c })),
    byDay: byDay.map((r) => ({ day: r.day, count: r.c })),
    byDayRange,
  });
});

router.get("/filters", (req, res) => {
  const actors = db.prepare("SELECT DISTINCT actor FROM audit_log ORDER BY actor").all().map((r) => r.actor);
  const actions = db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);
  const projects = db.prepare("SELECT id, name FROM projects ORDER BY name").all();
  res.json({ actors, actions, projects });
});

router.get("/", (req, res) => {
  const { where, params } = buildWhere(req.query);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log ${where}`).get(params).c;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all(Object.assign({}, params, { limit, offset }));
  res.json({ total, entries: rows.map(serializeRow) });
});

module.exports = router;
