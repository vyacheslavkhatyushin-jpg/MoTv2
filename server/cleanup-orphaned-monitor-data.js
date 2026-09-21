/*
Разовая чистка "осиротевших" записей мониторинга — monitor_status/
monitor_events/monitor_tag_pulses для equipment_id, которого больше нет в
текущем снимке проекта (объект был удалён из модели, но до этой правки
routes/projects.js:PUT /:id/state ничего не чистило за собой — см. git-
историю). Такие строки не показываются как объект нигде в интерфейсе, но
их state/person_count/vehicle_count продолжают подмешиваться в общие суммы
на странице "Мониторинг" (applyMonitorStatus в index.html), давая
необъяснимое на вид расхождение между суммой наверху и тем, что видно в
списке.

Без --yes — только показывает, что будет удалено, ничего не трогает.

Usage:
  node cleanup-orphaned-monitor-data.js [projectId] [--yes]

Example:
  node cleanup-orphaned-monitor-data.js apk           # предпросмотр по одному проекту
  node cleanup-orphaned-monitor-data.js apk --yes      # удалить по одному проекту
  node cleanup-orphaned-monitor-data.js --yes          # удалить по всем проектам сразу
*/
const db = require("./db");

const [, , ...rest] = process.argv;
const yes = rest.includes("--yes");
const projectIdArg = rest.find((a) => a !== "--yes");

const projects = projectIdArg
  ? [{ id: projectIdArg }]
  : db.prepare("SELECT id FROM projects ORDER BY id").all();

let totalOrphans = 0;
for (const { id: projectId } of projects) {
  const stateRow = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  if (!stateRow) continue;
  let snapshot;
  try {
    snapshot = JSON.parse(stateRow.snapshot_json);
  } catch (err) {
    console.error(`[${projectId}] bad snapshot_json: ${err.message} — пропускаю`);
    continue;
  }
  const validIds = new Set((snapshot.equipment || []).map((eq) => eq.id));

  const statusIds = db.prepare("SELECT equipment_id FROM monitor_status WHERE project_id = ?").all(projectId).map((r) => r.equipment_id);
  const orphanIds = [...new Set(statusIds)].filter((eid) => !validIds.has(eid));
  if (!orphanIds.length) continue;

  const eventsCount = db.prepare(
    `SELECT COUNT(*) c FROM monitor_events WHERE project_id = ? AND equipment_id IN (${orphanIds.map(() => "?").join(",")})`
  ).get(projectId, ...orphanIds).c;
  const pulsesCount = db.prepare(
    `SELECT COUNT(*) c FROM monitor_tag_pulses WHERE project_id = ? AND equipment_id IN (${orphanIds.map(() => "?").join(",")})`
  ).get(projectId, ...orphanIds).c;

  console.log(`[${projectId}] осиротевших equipment_id в monitor_status: ${orphanIds.length} (${orphanIds.join(", ")})`);
  console.log(`[${projectId}]   monitor_status: ${orphanIds.length} строк, monitor_events: ${eventsCount}, monitor_tag_pulses: ${pulsesCount}`);
  totalOrphans += orphanIds.length;

  if (yes) {
    const tx = db.transaction((ids) => {
      for (const eid of ids) {
        db.prepare("DELETE FROM monitor_status WHERE project_id = ? AND equipment_id = ?").run(projectId, eid);
        db.prepare("DELETE FROM monitor_events WHERE project_id = ? AND equipment_id = ?").run(projectId, eid);
        db.prepare("DELETE FROM monitor_tag_pulses WHERE project_id = ? AND equipment_id = ?").run(projectId, eid);
      }
    });
    tx(orphanIds);
    console.log(`[${projectId}]   удалено.`);
  }
}

if (!totalOrphans) {
  console.log("Осиротевших записей мониторинга не найдено.");
  process.exit(0);
}

if (!yes) {
  console.log(`\nЭто только предпросмотр — ничего не удалено. Всего осиротевших equipment_id: ${totalOrphans}.`);
  console.log(`Чтобы удалить по-настоящему, добавьте --yes:\n  node cleanup-orphaned-monitor-data.js ${projectIdArg || ""} --yes`);
} else {
  console.log(`\nГотово. Осиротевших equipment_id удалено: ${totalOrphans}.`);
}
