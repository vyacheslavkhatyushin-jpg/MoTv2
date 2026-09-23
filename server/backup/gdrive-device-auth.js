/*
Разовый скрипт: получить BACKUP_GDRIVE_REFRESH_TOKEN для цели бэкапа
"Google Drive" (server/backup/targets/gdrive.js) через OAuth Device Flow —
без браузера на самом сервере, авторизация проходит на любом другом
устройстве по короткому коду. См. docs/backup-setup.md.

Запуск (на сервере, там же где будет крутиться бэкап):
  BACKUP_GDRIVE_CLIENT_ID=... BACKUP_GDRIVE_CLIENT_SECRET=... node gdrive-device-auth.js

client_id/client_secret — из OAuth-клиента типа "TVs and Limited Input
devices" в Google Cloud Console (APIs & Services → Credentials).
*/
const clientId = process.env.BACKUP_GDRIVE_CLIENT_ID;
const clientSecret = process.env.BACKUP_GDRIVE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Нужны переменные BACKUP_GDRIVE_CLIENT_ID и BACKUP_GDRIVE_CLIENT_SECRET (см. docs/backup-setup.md)");
  process.exit(1);
}

async function main() {
  const deviceRes = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
    }),
  });
  const device = await deviceRes.json();
  if (!deviceRes.ok) {
    console.error("Ошибка запроса device code:", device);
    process.exit(1);
  }

  console.log("\nОткройте на любом устройстве (телефон, свой компьютер и т.п.):");
  console.log("  " + device.verification_url);
  console.log("Введите код:  " + device.user_code + "\n");
  console.log("Жду подтверждения...");

  const intervalMs = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 1800) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const token = await tokenRes.json();
    if (tokenRes.ok) {
      console.log("\nГотово! Добавьте строку в .env:\n");
      console.log("BACKUP_GDRIVE_REFRESH_TOKEN=" + token.refresh_token);
      return;
    }
    if (token.error && token.error !== "authorization_pending" && token.error !== "slow_down") {
      console.error("Ошибка авторизации:", token.error, token.error_description || "");
      process.exit(1);
    }
  }
  console.error("Время ожидания истекло, запустите скрипт заново.");
  process.exit(1);
}

main();
