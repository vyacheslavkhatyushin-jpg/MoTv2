/*
Цель бэкапа "Google Drive" — через OAuth2 refresh-token от ЛИЧНОГО
Google-аккаунта (не сервисный аккаунт: у тех нет своей квоты хранилища и
они не могут владеть файлами в обычной папке личного Диска — только в
Shared Drive, а это функция Google Workspace).

В отличие от SSH-цели (файловый секрет на сервере), Client ID/Secret и
refresh-token тут хранятся в backup_settings (БД) — подключение целиком
через UI (см. server/routes/backup.js, POST /gdrive/connect), без
консоли и .env. Осознанное исключение из общего принципа "секреты не в
БД", см. комментарий у CREATE TABLE backup_settings в server/db.js.
*/
const fs = require("fs");
const { google } = require("googleapis");
const db = require("../../db");

function readConfig() {
  const row = db
    .prepare("SELECT gdrive_client_id, gdrive_client_secret, gdrive_refresh_token, gdrive_folder_id FROM backup_settings WHERE id = 1")
    .get();
  if (!row || !row.gdrive_client_id || !row.gdrive_client_secret || !row.gdrive_refresh_token || !row.gdrive_folder_id) {
    return null;
  }
  return {
    clientId: row.gdrive_client_id,
    clientSecret: row.gdrive_client_secret,
    refreshToken: row.gdrive_refresh_token,
    folderId: row.gdrive_folder_id,
  };
}

function isConfigured() {
  return !!readConfig();
}

function driveClient(cfg) {
  const oauth2Client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  oauth2Client.setCredentials({ refresh_token: cfg.refreshToken });
  return google.drive({ version: "v3", auth: oauth2Client });
}

async function upload(localPath, fileName) {
  const cfg = readConfig();
  if (!cfg) throw new Error("Google Drive-цель не настроена (Настройки → Резервное копирование → Подключить Google Drive)");
  const drive = driveClient(cfg);
  await drive.files.create({
    requestBody: { name: fileName, parents: [cfg.folderId] },
    media: { mimeType: "application/x-sqlite3", body: fs.createReadStream(localPath) },
    fields: "id",
  });
}

module.exports = { name: "gdrive", isConfigured, upload, readConfig };
