/*
Цель бэкапа "Google Drive" — через OAuth2 refresh-token от ЛИЧНОГО
Google-аккаунта (не сервисный аккаунт): у сервисных аккаунтов нет своей
квоты хранилища, и они не могут владеть файлами в обычной папке личного
Диска — только в Shared Drive, а это функция Google Workspace, которой
на личном Gmail-аккаунте нет. Refresh-token получается один раз через
Device Flow — см. server/backup/gdrive-device-auth.js и
docs/backup-setup.md.
*/
const fs = require("fs");
const { google } = require("googleapis");

function readConfig() {
  const clientId = process.env.BACKUP_GDRIVE_CLIENT_ID;
  const clientSecret = process.env.BACKUP_GDRIVE_CLIENT_SECRET;
  const refreshToken = process.env.BACKUP_GDRIVE_REFRESH_TOKEN;
  const folderId = process.env.BACKUP_GDRIVE_FOLDER_ID;
  if (!clientId || !clientSecret || !refreshToken || !folderId) return null;
  return { clientId, clientSecret, refreshToken, folderId };
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
  if (!cfg) throw new Error("Google Drive-цель не настроена (переменные окружения BACKUP_GDRIVE_*)");
  const drive = driveClient(cfg);
  await drive.files.create({
    requestBody: { name: fileName, parents: [cfg.folderId] },
    media: { mimeType: "application/x-sqlite3", body: fs.createReadStream(localPath) },
    fields: "id",
  });
}

module.exports = { name: "gdrive", isConfigured, upload };
