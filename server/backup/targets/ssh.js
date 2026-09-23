/*
Цель бэкапа "другой сервер по SSH" — учётные данные ТОЛЬКО из окружения
(см. docs/backup-setup.md), никогда из БД/UI: BACKUP_SSH_HOST,
BACKUP_SSH_USER, BACKUP_SSH_KEY_PATH (путь к приватному ключу внутри
контейнера — монтируется read-only volume'ом), BACKUP_SSH_REMOTE_DIR.
Порт — необязательный BACKUP_SSH_PORT (по умолчанию 22).
*/
const fs = require("fs");
const path = require("path");
const Client = require("ssh2-sftp-client");

function readConfig() {
  const host = process.env.BACKUP_SSH_HOST;
  const user = process.env.BACKUP_SSH_USER;
  const keyPath = process.env.BACKUP_SSH_KEY_PATH;
  const remoteDir = process.env.BACKUP_SSH_REMOTE_DIR;
  const port = parseInt(process.env.BACKUP_SSH_PORT || "22", 10);
  if (!host || !user || !keyPath || !remoteDir) return null;
  return { host, user, keyPath, remoteDir, port };
}

// Отдельно от readConfig(): "переменные заданы" не значит "ключ реально
// лежит по указанному пути" (частая ошибка при монтировании volume) —
// isConfigured() проверяет оба условия, чтобы UI мог честно показать
// "не настроено" вместо того, чтобы упасть только в момент бэкапа.
function isConfigured() {
  const cfg = readConfig();
  if (!cfg) return false;
  try {
    fs.accessSync(cfg.keyPath, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function upload(localPath, fileName) {
  const cfg = readConfig();
  if (!cfg) throw new Error("SSH-цель не настроена (переменные окружения BACKUP_SSH_*)");
  const client = new Client();
  try {
    await client.connect({
      host: cfg.host, port: cfg.port, username: cfg.user,
      privateKey: fs.readFileSync(cfg.keyPath),
    });
    const remotePath = path.posix.join(cfg.remoteDir, fileName);
    await client.put(localPath, remotePath);
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { name: "ssh", isConfigured, upload };
