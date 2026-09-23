/*
Подключение цели "Google Drive" (см. targets/gdrive.js) через OAuth Device
Flow — полностью с сервера, без браузера/консоли на самой машине: админ
жмёт "Подключить" в Настройках, получает код+ссылку прямо в интерфейсе,
открывает её на любом другом устройстве (телефон, свой компьютер),
разрешает доступ под своим Google-аккаунтом. Этот модуль опрашивает
Google в фоне и сам пишет refresh-token в backup_settings, как только
подтверждение придёт — фронтенду остаётся только поллить getStatus().

Client ID/Secret создаются один раз в Google Cloud Console (это требование
самого Google, обойти нельзя) — тип OAuth-клиента "TVs and Limited Input
devices", см. docs/backup-setup.md.
*/
const db = require("../db");

let state = { status: "idle" };
let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function getStatus() {
  const { status, verificationUrl, userCode, expiresAt, message } = state;
  return { status, verificationUrl, userCode, expiresAt, message };
}

function saveClientCreds({ clientId, clientSecret, folderId }) {
  db.prepare(
    "UPDATE backup_settings SET gdrive_client_id = ?, gdrive_client_secret = ?, gdrive_folder_id = ? WHERE id = 1"
  ).run(clientId, clientSecret, folderId);
}

function saveRefreshToken(refreshToken) {
  db.prepare("UPDATE backup_settings SET gdrive_refresh_token = ? WHERE id = 1").run(refreshToken);
}

function disconnect() {
  stopPolling();
  db.prepare(
    "UPDATE backup_settings SET gdrive_client_id = NULL, gdrive_client_secret = NULL, gdrive_refresh_token = NULL, gdrive_folder_id = NULL, target_gdrive_enabled = 0 WHERE id = 1"
  ).run();
  state = { status: "idle" };
}

async function pollOnce(clientId, clientSecret, deviceCode) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = await res.json();
  return { ok: res.ok, body };
}

function schedulePoll(clientId, clientSecret, device) {
  const intervalMs = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 1800) * 1000;

  const tick = async () => {
    if (Date.now() > deadline) {
      state = { status: "error", message: "Время ожидания истекло, начните подключение заново." };
      return;
    }
    try {
      const { ok, body } = await pollOnce(clientId, clientSecret, device.device_code);
      if (ok) {
        saveRefreshToken(body.refresh_token);
        state = { status: "success" };
        return;
      }
      if (body.error && body.error !== "authorization_pending" && body.error !== "slow_down") {
        state = { status: "error", message: body.error_description || body.error };
        return;
      }
    } catch (e) {
      state = { status: "error", message: e.message };
      return;
    }
    pollTimer = setTimeout(tick, intervalMs);
  };
  pollTimer = setTimeout(tick, intervalMs);
}

async function startConnect({ clientId, clientSecret, folderId }) {
  stopPolling();
  saveClientCreds({ clientId, clientSecret, folderId });

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
    state = { status: "error", message: device.error_description || device.error || "Ошибка запроса кода у Google" };
    throw new Error(state.message);
  }

  state = {
    status: "pending",
    verificationUrl: device.verification_url,
    userCode: device.user_code,
    expiresAt: Date.now() + (device.expires_in || 1800) * 1000,
  };
  schedulePoll(clientId, clientSecret, device);
  return getStatus();
}

module.exports = { startConnect, getStatus, disconnect };
