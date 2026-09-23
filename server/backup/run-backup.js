/*
Ядро автобэкапа — вызывается и из основного сервера (POST /api/backup/run-now,
см. server/routes/backup.js), и из отдельного планировщика (см.
server/backup-worker.js). Оба процесса делят одну и ту же SQLite-базу через
volume, а db.backup() — официальный online backup API SQLite: безопасно
снимать копию, пока идёт живая работа с базой (чтение/запись не блокируются),
поэтому вызывать его прямо из процесса редактора не рискованно.

Секреты офсайт-целей нигде здесь не хранятся — targets/ssh.js и
targets/gdrive.js сами читают свои переменные окружения (см.
docs/backup-setup.md), этот модуль только решает, каких из них КЛЮЧОМ
включить (backup_settings.target_*_enabled) и вызывает upload().
*/
const fs = require("fs");
const path = require("path");
const db = require("../db");
const sshTarget = require("./targets/ssh");
const gdriveTarget = require("./targets/gdrive");

const TARGETS = [sshTarget, gdriveTarget];
const BACKUP_DIR = path.join(path.dirname(db.DB_PATH), "backups");

function getSettings() {
  return db.prepare("SELECT * FROM backup_settings WHERE id = 1").get();
}

function listLocalBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".db"))
    .sort() // имена содержат сортируемый ISO-таймстамп, см. makeFileName()
    .map((f) => path.join(BACKUP_DIR, f));
}

function rotateLocalBackups(retentionCount) {
  const files = listLocalBackups();
  const excess = files.length - retentionCount;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(files[i]); } catch (e) { /* уже удалён/недоступен — не критично */ }
  }
}

function makeFileName() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `backup-${ts}.db`;
}

// Advisory-защита от двух одновременных запусков (плановый + ручной "Сделать
// бэкап сейчас" совпали по времени) — не блокировка на уровне ОС, просто
// проверка последней строки: "running" моложе часа считаем реально висящей,
// старше — значит процесс упал без записи финального статуса, не мешаем.
function isAnotherRunInProgress() {
  const row = db.prepare("SELECT started_at FROM backup_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get();
  if (!row) return false;
  const startedMs = Date.parse(row.started_at.replace(" ", "T") + "Z");
  return Date.now() - startedMs < 60 * 60 * 1000;
}

async function runBackup({ triggeredBy }) {
  if (isAnotherRunInProgress()) {
    throw new Error("Бэкап уже выполняется (запущен менее часа назад)");
  }
  const settings = getSettings();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const fileName = makeFileName();
  const filePath = path.join(BACKUP_DIR, fileName);

  const insertRun = db.prepare(
    "INSERT INTO backup_runs (triggered_by, local_file) VALUES (?, ?)"
  );
  const runId = insertRun.run(triggeredBy, fileName).lastInsertRowid;

  const targetsResult = {};
  let overallError = null;
  try {
    await db.backup(filePath);
    rotateLocalBackups(Math.max(1, settings.local_retention_count));

    const enabledTargets = TARGETS.filter((t) =>
      settings[`target_${t.name}_enabled`] && t.isConfigured()
    );
    for (const target of enabledTargets) {
      try {
        await target.upload(filePath, fileName);
        targetsResult[target.name] = { ok: true };
      } catch (e) {
        targetsResult[target.name] = { ok: false, error: e.message };
      }
    }
  } catch (e) {
    overallError = e.message;
  }

  const targetErrors = Object.values(targetsResult).filter((r) => !r.ok).length;
  const status = overallError ? "failed" : targetErrors > 0 ? "partial" : "success";
  let sizeBytes = null;
  try { sizeBytes = fs.statSync(filePath).size; } catch (e) { /* backup сам провалился — файла нет */ }

  db.prepare(
    `UPDATE backup_runs SET finished_at = datetime('now'), status = ?, local_size_bytes = ?,
      targets_json = ?, error = ? WHERE id = ?`
  ).run(status, sizeBytes, JSON.stringify(targetsResult), overallError, runId);

  if (overallError) throw new Error(overallError);
  return { status, targetsResult };
}

module.exports = { runBackup, getSettings, listLocalBackups, BACKUP_DIR };
