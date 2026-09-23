/*
Плановый автобэкап БД (Настройки → Резервное копирование) — отдельный
процесс, тот же паттерн, что monitor/ping-worker.js: сетевая загрузка на
офсайт-цель (SSH/Google Drive) может подвиснуть/затупить, и это не должно
задевать основной сервер редактора. Общая SQLite-база — через тот же volume
(server/db.js берёт путь из DB_PATH так же, как у основного сервера).

Расписание — время суток (UTC), настраивается в БД (backup_settings.
schedule_time), не через env — в отличие от PING_INTERVAL_MS у пингера,
это не интервал, а "во сколько запускать раз в день", поэтому логичнее
крутить его в самой БД рядом с остальными настройками бэкапа, а не
перезапускать контейнер ради смены времени.
*/
const db = require("./db");
const { runBackup } = require("./backup/run-backup");

const CHECK_INTERVAL_MS = 60 * 1000;
let lastRunDate = null; // "YYYY-MM-DD" (UTC) — не даём сработать дважды в одну и ту же минуту-совпадение

function getSettings() {
  return db.prepare("SELECT enabled, schedule_time FROM backup_settings WHERE id = 1").get();
}

function isDueNow(scheduleTime) {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}` === scheduleTime;
}

async function tick() {
  const settings = getSettings();
  if (!settings || !settings.enabled) return;
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (lastRunDate === todayUtc) return; // уже отработали сегодня
  if (!isDueNow(settings.schedule_time)) return;

  lastRunDate = todayUtc;
  console.log(`[backup-worker] scheduled backup starting (${settings.schedule_time} UTC)`);
  try {
    const result = await runBackup({ triggeredBy: "schedule" });
    console.log(`[backup-worker] done: ${result.status}`, result.targetsResult);
  } catch (e) {
    console.error("[backup-worker] failed:", e.message);
  }
}

async function loop() {
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("[backup-worker] tick failed:", err);
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

if (require.main === module) {
  console.log("[backup-worker] starting — checking schedule every 60s (UTC)");
  loop();
}

module.exports = { tick, isDueNow };
