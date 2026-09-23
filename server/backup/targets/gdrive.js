/*
Цель бэкапа "Google Drive" — через сервисный аккаунт (см.
docs/backup-setup.md), НЕ личный аккаунт: BACKUP_GDRIVE_SA_KEY_PATH (путь
к JSON-ключу сервисного аккаунта внутри контейнера — монтируется
read-only volume'ом), BACKUP_GDRIVE_FOLDER_ID (id папки на Drive, куда
складывать — папка должна быть расшарена сервисному аккаунту с правом
"Редактор", иначе загрузка упадёт с 403).
*/
const fs = require("fs");
const { google } = require("googleapis");

function readConfig() {
  const keyPath = process.env.BACKUP_GDRIVE_SA_KEY_PATH;
  const folderId = process.env.BACKUP_GDRIVE_FOLDER_ID;
  if (!keyPath || !folderId) return null;
  return { keyPath, folderId };
}

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
  if (!cfg) throw new Error("Google Drive-цель не настроена (переменные окружения BACKUP_GDRIVE_*)");
  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.keyPath,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: "v3", auth });
  await drive.files.create({
    requestBody: { name: fileName, parents: [cfg.folderId] },
    media: { mimeType: "application/x-sqlite3", body: fs.createReadStream(localPath) },
    fields: "id",
  });
}

module.exports = { name: "gdrive", isConfigured, upload };
