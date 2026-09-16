/*
Фонари — статистика работоспособности по отчёту "Текущие местоположение"
(SPPD/SBeacon), см. server/lib/lampReportParser.js. Данные приходят не
живым потоком, а ручной загрузкой .xls/.xlsx — разные шахты (apk/ipk/opk)
экспортируют этот отчёт в разных форматах, парсер это учитывает.

Роли: смотреть статистику может любой авторизованный (viewer и выше);
загружать новый отчёт — editor/admin (как правки объектов в редакторе).
*/
const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { parseLampReport } = require("../lib/lampReportParser");

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

// Плейсхолдер для пустого подразделения — используется и в самих записях, и
// в агрегации по подразделениям, чтобы значение из выпадающего фильтра на
// клиенте совпадало с department на записи (раньше клиент фильтровал по
// сырому "", а в выпадающем списке была видна только подпись-плейсхолдер —
// фильтр по "(без подразделения)" не находил ничего).
const NO_DEPARTMENT = "(без подразделения)";

const stmtGetLampThreshold = db.prepare("SELECT lamp_fail_after_hours FROM project_monitor_thresholds WHERE project_id = ?");
function getLampFailAfterHours(projectId) {
  const row = stmtGetLampThreshold.get(projectId);
  return row ? row.lamp_fail_after_hours : 24;
}

function serializeReportSummary(row) {
  return {
    id: row.id,
    generatedAt: row.generated_at,
    sourceFilename: row.source_filename,
    totalCount: row.total_count,
    okCount: row.ok_count,
    brokenCount: row.broken_count,
    uptimePct: row.total_count > 0 ? Math.round((row.ok_count / row.total_count) * 1000) / 10 : null,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

// Ограничение размера — эти отчёты по факту десятки КБ – единицы МБ
// (сотни-тысячи строк), 15 МБ — щедрый запас, не для произвольных файлов.
const UPLOAD_LIMIT = "15mb";
const uploadParser = express.raw({ type: () => true, limit: UPLOAD_LIMIT });

router.post("/:id/lamps/reports", requireRole("editor", "admin"), uploadParser, (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;

  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: "empty_file" });
  }
  const filename = typeof req.query.filename === "string" ? req.query.filename : null;

  let parsed;
  try {
    parsed = parseLampReport(req.body, filename);
  } catch (err) {
    return res.status(400).json({ error: "parse_failed", message: err.message });
  }
  if (!parsed.records.length) {
    return res.status(400).json({ error: "no_records", message: "В отчёте не найдено ни одной строки с данными" });
  }

  const failAfterMs = getLampFailAfterHours(req.params.id) * 3600 * 1000;
  const nowMs = parsed.reportGeneratedAt.getTime();
  let okCount = 0;
  let brokenCount = 0;
  const recordsWithStatus = parsed.records.map((r) => {
    const isBroken = nowMs - r.lastSeenAt.getTime() > failAfterMs ? 1 : 0;
    if (isBroken) brokenCount++;
    else okCount++;
    return { ...r, isBroken };
  });

  const reportId = "lamp_report_" + crypto.randomUUID();
  const insertReport = db.prepare(
    `INSERT INTO lamp_reports (id, project_id, generated_at, source_filename, total_count, ok_count, broken_count, uploaded_by)
     VALUES (@id, @projectId, @generatedAt, @sourceFilename, @totalCount, @okCount, @brokenCount, @uploadedBy)`
  );
  const insertRecord = db.prepare(
    `INSERT INTO lamp_records (report_id, tab_number, full_name, position, department, organization, lamp_id, reader, last_seen_at, is_broken)
     VALUES (@reportId, @tabNumber, @fullName, @position, @department, @organization, @lampId, @reader, @lastSeenAt, @isBroken)`
  );

  const insertAll = db.transaction(() => {
    insertReport.run({
      id: reportId,
      projectId: req.params.id,
      generatedAt: parsed.reportGeneratedAt.toISOString(),
      sourceFilename: parsed.sourceFilename,
      totalCount: recordsWithStatus.length,
      okCount,
      brokenCount,
      uploadedBy: req.user.username,
    });
    for (const r of recordsWithStatus) {
      insertRecord.run({
        reportId,
        tabNumber: r.tabNumber,
        fullName: r.fullName,
        position: r.position,
        department: r.department,
        organization: r.organization,
        lampId: r.lampId,
        reader: r.reader,
        lastSeenAt: r.lastSeenAt.toISOString(),
        isBroken: r.isBroken,
      });
    }
  });
  insertAll();

  const row = db.prepare("SELECT * FROM lamp_reports WHERE id = ?").get(reportId);
  res.status(201).json(serializeReportSummary(row));
});

// История загрузок — для переключателя отчётов и тренда (спарклайн
// % исправности по последним загрузкам). limit ограничивает тренд разумным
// окном, а не тянет вообще все загрузки за всё время.
router.get("/:id/lamps/reports", (req, res) => {
  if (!requireProject(req, res)) return;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const rows = db
    .prepare("SELECT * FROM lamp_reports WHERE project_id = ? ORDER BY generated_at DESC LIMIT ?")
    .all(req.params.id, limit);
  res.json({ reports: rows.map(serializeReportSummary) });
});

router.get("/:id/lamps/reports/:reportId", (req, res) => {
  if (!requireProject(req, res)) return;
  const reportId = req.params.reportId;

  const reportRow =
    reportId === "latest"
      ? db.prepare("SELECT * FROM lamp_reports WHERE project_id = ? ORDER BY generated_at DESC LIMIT 1").get(req.params.id)
      : db.prepare("SELECT * FROM lamp_reports WHERE project_id = ? AND id = ?").get(req.params.id, reportId);
  if (!reportRow) return res.status(404).json({ error: "report_not_found" });

  const records = db
    .prepare(
      `SELECT tab_number, full_name, position, department, organization, lamp_id, reader, last_seen_at, is_broken
       FROM lamp_records WHERE report_id = ? ORDER BY is_broken DESC, last_seen_at ASC`
    )
    .all(reportRow.id)
    .map((r) => ({
      tabNumber: r.tab_number,
      fullName: r.full_name,
      position: r.position,
      department: r.department || NO_DEPARTMENT,
      organization: r.organization,
      lampId: r.lamp_id,
      reader: r.reader,
      lastSeenAt: r.last_seen_at,
      isBroken: !!r.is_broken,
    }));

  const departmentRows = db
    .prepare(
      `SELECT department, COUNT(*) AS total, SUM(is_broken) AS broken
       FROM lamp_records WHERE report_id = ? GROUP BY department ORDER BY broken DESC, total DESC`
    )
    .all(reportRow.id)
    .map((r) => ({ department: r.department || NO_DEPARTMENT, total: r.total, broken: r.broken }));

  res.json({
    report: serializeReportSummary(reportRow),
    departments: departmentRows,
    records,
    lampFailAfterHours: getLampFailAfterHours(req.params.id),
  });
});

module.exports = router;
