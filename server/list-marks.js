/*
Диагностика для ручной чистки БД: печатает все метки (marks) проекта из
project_state.snapshot_json с их id/label/position/createdAt, чтобы
можно было точно опознать нужную перед удалением через delete-object.js.

Usage:
  node list-marks.js <projectId> [labelSubstring]

Examples:
  node list-marks.js apk
  node list-marks.js apk "ODF-24"
*/
const db = require("./db");

const [, , projectId, labelSubstring] = process.argv;
if (!projectId) {
  console.error("Usage: node list-marks.js <projectId> [labelSubstring]");
  process.exit(1);
}

const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
if (!row) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}
const snapshot = JSON.parse(row.snapshot_json);
const marks = snapshot.marks || [];
const filtered = labelSubstring
  ? marks.filter((m) => (m.label || "").includes(labelSubstring))
  : marks;

if (!filtered.length) {
  console.log(`Меток не найдено (всего в проекте: ${marks.length}).`);
  process.exit(0);
}
for (const m of filtered) {
  console.log(JSON.stringify({
    id: m.id, label: m.label, position: m.position,
    createdBy: m.createdBy, createdAt: m.createdAt,
  }));
}
console.log(`Показано ${filtered.length} из ${marks.length} меток проекта.`);
