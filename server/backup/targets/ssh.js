/*
Цель бэкапа "другой сервер по SSH" — подключение целиком через UI
(Настройки → Резервное копирование → «Другой сервер по SSH»), как и
Google Drive: host/user/port/remoteDir и сам приватный ключ хранятся в
backup_settings (БД), не в .env/файлах — см. server/routes/backup.js,
POST /ssh/save.
*/
const path = require("path");
const Client = require("ssh2-sftp-client");
const db = require("../../db");

function readConfig() {
  const row = db
    .prepare("SELECT ssh_host, ssh_user, ssh_port, ssh_remote_dir, ssh_private_key FROM backup_settings WHERE id = 1")
    .get();
  if (!row || !row.ssh_host || !row.ssh_user || !row.ssh_remote_dir || !row.ssh_private_key) return null;
  return {
    host: row.ssh_host,
    user: row.ssh_user,
    port: row.ssh_port ? parseInt(row.ssh_port, 10) : 22,
    remoteDir: row.ssh_remote_dir,
    privateKey: row.ssh_private_key,
  };
}

function isConfigured() {
  return !!readConfig();
}

async function connectWith(cfg) {
  const client = new Client();
  await client.connect({ host: cfg.host, port: cfg.port, username: cfg.user, privateKey: cfg.privateKey });
  return client;
}

async function upload(localPath, fileName) {
  const cfg = readConfig();
  if (!cfg) throw new Error("SSH-цель не настроена (Настройки → Резервное копирование → Другой сервер по SSH)");
  const client = await connectWith(cfg);
  try {
    const remotePath = path.posix.join(cfg.remoteDir, fileName);
    await client.put(localPath, remotePath);
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { name: "ssh", isConfigured, upload, readConfig, connectWith };
