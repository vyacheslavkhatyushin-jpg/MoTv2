/*
Настройки автобэкапа БД (Настройки → Резервное копирование) — глобально на
всю систему, не per-project (как Пользователи). Обе офсайт-цели (SSH и
Google Drive) настраиваются и хранятся тут же, в БД (backup_settings, см.
server/db.js) — секреты (приватный ключ, OAuth client secret/refresh-token)
ПРИНИМАЮТСЯ через /ssh/save и /gdrive/connect, но никогда не отдаются
обратно в GET/serializeSettings — только флаги "включено/настроено" (см.
server/backup/targets/*.js и docs/backup-setup.md). Плановый запуск —
server/backup-worker.js (отдельный процесс), "Сделать бэкап сейчас" ниже
запускает ровно тот же код напрямую из основного сервера: db.backup() —
online backup API SQLite, безопасно работает параллельно с живыми
запросами, отдельный процесс тут не нужен.
*/
const express = require("express");
const fs = require("fs");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const { runBackup, getSettings, listLocalBackups } = require("../backup/run-backup");
const sshTarget = require("../backup/targets/ssh");
const gdriveTarget = require("../backup/targets/gdrive");
const gdriveOAuth = require("../backup/gdrive-oauth");

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
      ssh: {
        enabled: !!row.target_ssh_enabled,
        configured: sshTarget.isConfigured(),
        host: row.ssh_host || null,
        user: row.ssh_user || null,
        port: row.ssh_port || null,
        remoteDir: row.ssh_remote_dir || null,
      },
      gdrive: {
        enabled: !!row.target_gdrive_enabled,
        configured: gdriveTarget.isConfigured(),
        clientId: row.gdrive_client_id || null,
        folderId: row.gdrive_folder_id || null,
        connect: gdriveOAuth.getStatus(),
      },
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

// Подключение SSH-цели целиком через UI — в отличие от Google Drive тут
// не нужен внешний OAuth-шаг: просто сохраняем host/user/port/remoteDir и
// сам приватный ключ (в БД, см. server/db.js) и сразу пробуем подключиться
// и открыть remoteDir, чтобы не ждать первого планового бэкапа для
// проверки опечатки в хосте/ключе.
router.post("/ssh/save", async (req, res) => {
  const { host, user, port, remoteDir, privateKey } = req.body || {};
  if (!host || typeof host !== "string") return res.status(400).json({ error: "invalid_host" });
  if (!user || typeof user !== "string") return res.status(400).json({ error: "invalid_user" });
  if (!remoteDir || typeof remoteDir !== "string") return res.status(400).json({ error: "invalid_remote_dir" });
  if (!privateKey || typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    return res.status(400).json({ error: "invalid_private_key" });
  }
  const portNum = port ? parseInt(port, 10) : 22;
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return res.status(400).json({ error: "invalid_port" });

  db.prepare(
    "UPDATE backup_settings SET ssh_host = ?, ssh_user = ?, ssh_port = ?, ssh_remote_dir = ?, ssh_private_key = ? WHERE id = 1"
  ).run(host, user, portNum, remoteDir, privateKey);
  logAudit({ actor: req.user.username, action: "backup.ssh.save", entityType: "backup_settings", ip: req.ip });

  try {
    const client = await sshTarget.connectWith({ host, user, port: portNum, privateKey });
    await client.list(remoteDir);
    await client.end().catch(() => {});
    res.json({ ok: true, tested: true, ...serializeSettings() });
  } catch (e) {
    res.json({ ok: true, tested: false, testError: e.message, ...serializeSettings() });
  }
});

router.post("/ssh/disconnect", (req, res) => {
  db.prepare(
    "UPDATE backup_settings SET ssh_host = NULL, ssh_user = NULL, ssh_port = NULL, ssh_remote_dir = NULL, ssh_private_key = NULL, target_ssh_enabled = 0 WHERE id = 1"
  ).run();
  logAudit({ actor: req.user.username, action: "backup.ssh.disconnect", entityType: "backup_settings", ip: req.ip });
  res.json(serializeSettings());
});

// Подключение Google Drive целиком через UI (Device Flow) — Client ID/
// Secret создаются один раз в Google Cloud Console (требование самого
// Google, см. docs/backup-setup.md), но дальше уже без консоли: код и
// ссылка отдаются прямо сюда, фронтенд поллит /gdrive/status.
router.post("/gdrive/connect", async (req, res) => {
  const { clientId, clientSecret, folderId } = req.body || {};
  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "invalid_client_id" });
  if (!clientSecret || typeof clientSecret !== "string") return res.status(400).json({ error: "invalid_client_secret" });
  if (!folderId || typeof folderId !== "string") return res.status(400).json({ error: "invalid_folder_id" });
  try {
    const status = await gdriveOAuth.startConnect({ clientId, clientSecret, folderId });
    logAudit({ actor: req.user.username, action: "backup.gdrive.connect_start", entityType: "backup_settings", ip: req.ip });
    res.json(status);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/gdrive/status", (req, res) => {
  res.json(gdriveOAuth.getStatus());
});

router.post("/gdrive/disconnect", (req, res) => {
  gdriveOAuth.disconnect();
  logAudit({ actor: req.user.username, action: "backup.gdrive.disconnect", entityType: "backup_settings", ip: req.ip });
  res.json(serializeSettings());
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
