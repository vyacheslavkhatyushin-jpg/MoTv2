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
// index — позиция в массиве marks, а не порядковый номер среди
// отфильтрованных: нужна как раз она, чтобы delete-object.js мог найти
// объект по --index, даже если у него в БД вообще нет поля id (бывает у
// старых/повреждённых записей — тогда id в выводе просто не появится,
// JSON.stringify выкидывает undefined-поля).
const filtered = marks
  .map((m, index) => ({ m, index }))
  .filter(({ m }) => !labelSubstring || (m.label || "").includes(labelSubstring));

if (!filtered.length) {
  console.log(`Меток не найдено (всего в проекте: ${marks.length}).`);
  process.exit(0);
}
for (const { m, index } of filtered) {
  console.log(JSON.stringify({
    index, id: m.id, label: m.label, position: m.position,
    createdBy: m.createdBy, createdAt: m.createdAt,
  }));
}
console.log(`Показано ${filtered.length} из ${marks.length} меток проекта.`);
if (marks.some((m) => !m.id)) {
  console.log(`Внимание: у части меток отсутствует id (не показан выше) — удалять такие можно только по --index, не по id.`);
}
