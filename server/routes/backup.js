/*
Настройки автобэкапа БД (Настройки → Резервное копирование) — глобально на
всю систему, не per-project (как Пользователи). Секреты офсайт-целей сюда
никогда не приходят и отсюда никогда не отдаются — только флаги
"включено/настроено ли окружением" (см. server/backup/targets/*.js и
docs/backup-setup.md). Плановый запуск — server/backup-worker.js (отдельный
процесс), "Сделать бэкап сейчас" ниже запускает ровно тот же код напрямую
из основного сервера: db.backup() — online backup API SQLite, безопасно
работает параллельно с живыми запросами, отдельный процесс тут не нужен.
*/
const express = require("express");
const fs = require("fs");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const { runBackup, getSettings, listLocalBackups } = require("../backup/run-backup");
const sshTarget = require("../backup/targets/ssh");
const gdriveTarget = require("../backup/targets/gdrive");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function serializeSettings() {
  const row = getSettings();
  const lastRun = db.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 1").get();
  const history = db.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 10").all();
  return {
    enabled: !!row.enabled,
    scheduleTime: row.schedule_time,
    localRetentionCount: row.local_retention_count,
    targets: {
      ssh: { enabled: !!row.target_ssh_enabled, configured: sshTarget.isConfigured() },
      gdrive: { enabled: !!row.target_gdrive_enabled, configured: gdriveTarget.isConfigured() },
    },
    localBackupCount: listLocalBackups().length,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    lastRun: lastRun ? serializeRun(lastRun) : null,
    history: history.map(serializeRun),
  };
}
function serializeRun(row) {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    triggeredBy: row.triggered_by,
    localFile: row.local_file,
    localSizeBytes: row.local_size_bytes,
    targets: row.targets_json ? JSON.parse(row.targets_json) : null,
    error: row.error,
  };
}

router.get("/settings", (req, res) => {
  res.json(serializeSettings());
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

router.put("/settings", (req, res) => {
  const { enabled, scheduleTime, localRetentionCount, targets } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "invalid_enabled" });
  if (typeof scheduleTime !== "string" || !TIME_RE.test(scheduleTime)) {
    return res.status(400).json({ error: "invalid_schedule_time" });
  }
  if (!Number.isInteger(localRetentionCount) || localRetentionCount < 1 || localRetentionCount > 90) {
    return res.status(400).json({ error: "invalid_local_retention_count" });
  }
  const sshEnabled = !!(targets && targets.ssh);
  const gdriveEnabled = !!(targets && targets.gdrive);
  // Включить цель можно, только если она реально настроена окружением —
  // иначе плановый бэкап будет молча (для пользователя) проваливать
  // загрузку каждый раз, а мы это разрешаем увидеть только как ошибку в
  // истории, не как немую невозможность включить чекбокс.
  if (sshEnabled && !sshTarget.isConfigured()) {
    return res.status(400).json({ error: "ssh_not_configured" });
  }
  if (gdriveEnabled && !gdriveTarget.isConfigured()) {
    return res.status(400).json({ error: "gdrive_not_configured" });
  }

  db.prepare(
    `UPDATE backup_settings SET enabled = ?, schedule_time = ?, local_retention_count = ?,
      target_ssh_enabled = ?, target_gdrive_enabled = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = 1`
  ).run(enabled ? 1 : 0, scheduleTime, localRetentionCount, sshEnabled ? 1 : 0, gdriveEnabled ? 1 : 0, req.user.username);

  logAudit({ actor: req.user.username, action: "backup.settings.update", entityType: "backup_settings", ip: req.ip });
  res.json(serializeSettings());
});

router.post("/run-now", async (req, res) => {
  try {
    logAudit({ actor: req.user.username, action: "backup.run_now", entityType: "backup_settings", ip: req.ip });
    const result = await runBackup({ triggeredBy: req.user.username });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Скачать конкретный локальный бэкап руками (проверить/унести самому,
// вне зависимости от настроенных офсайт-целей).
router.get("/files/:name", (req, res) => {
  const name = req.params.name;
  if (!/^backup-[\w.:-]+\.db$/.test(name)) return res.status(400).json({ error: "invalid_name" });
  const filePath = listLocalBackups().find((p) => p.endsWith("/" + name) || p.endsWith("\\" + name));
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "not_found" });
  res.download(filePath, name);
});

module.exports = router;
