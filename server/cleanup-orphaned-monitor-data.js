/*
Ручной запуск/предпросмотр той же чистки "осиротевших" записей мониторинга,
что теперь крутится сама по себе раз в сутки в основном сервере (см.
server.js и server/lib/cleanupOrphanedData.js — там же объяснение, ПОЧЕМУ
такие строки вообще появляются). Этот скрипт остаётся полезен для
ручной чистки прямо сейчас, не дожидаясь суточного тика, и для просмотра,
что вообще накопилось.

Без --yes — только показывает, что будет удалено, ничего не трогает.

Usage:
  node cleanup-orphaned-monitor-data.js [projectId] [--yes]

Example:
  node cleanup-orphaned-monitor-data.js apk           # предпросмотр по одному проекту
  node cleanup-orphaned-monitor-data.js apk --yes      # удалить по одному проекту
  node cleanup-orphaned-monitor-data.js --yes          # удалить по всем проектам сразу
*/
const { runCleanup } = require("./lib/cleanupOrphanedData");

const [, , ...rest] = process.argv;
const yes = rest.includes("--yes");
const projectId = rest.find((a) => a !== "--yes");

const { results, totalOrphanIds } = runCleanup({ projectId, dryRun: !yes, actor: "cli" });

for (const r of results) {
  console.log(`[${r.projectId}] осиротевших equipment_id в monitor_status: ${r.orphanIds.length} (${r.orphanIds.join(", ")})`);
  console.log(`[${r.projectId}]   monitor_status: ${r.orphanIds.length} строк, monitor_events: ${r.eventsCount}, monitor_tag_pulses: ${r.pulsesCount}`);
}

if (!totalOrphanIds) {
  console.log("Осиротевших записей мониторинга не найдено.");
  process.exit(0);
}

if (!yes) {
  console.log(`\nЭто только предпросмотр — ничего не удалено. Всего осиротевших equipment_id: ${totalOrphanIds}.`);
  console.log(`Чтобы удалить по-настоящему, добавьте --yes:\n  node cleanup-orphaned-monitor-data.js ${projectId || ""} --yes`);
} else {
  console.log(`\nГотово. Осиротевших equipment_id удалено: ${totalOrphanIds}.`);
}
