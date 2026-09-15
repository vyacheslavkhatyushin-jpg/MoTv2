/*
Ручное удаление одного объекта (кабель/оборудование/метка/заплатка)
напрямую из project_state.snapshot_json — на случай, когда обычное
удаление через интерфейс не срабатывает (например, дублирующиеся объекты
с одинаковой подписью, накладывающиеся в 3D и не разбираемые кликом).

Бьёт точно по id, версию снапшота увеличивает — как обычное сохранение,
чтобы не путать с параллельной правкой из интерфейса.

Usage:
  node delete-object.js <projectId> <collection> <objectId>
  collection: cables | equipment | marks | patches

Example:
  node list-marks.js apk "ODF-24"     # найти точный id
  node delete-object.js apk marks m_abc123
*/
const db = require("./db");

const [, , projectId, collection, objectId] = process.argv;
const VALID = new Set(["cables", "equipment", "marks", "patches"]);
if (!projectId || !VALID.has(collection) || !objectId) {
  console.error("Usage: node delete-object.js <projectId> <cables|equipment|marks|patches> <objectId>");
  process.exit(1);
}

const row = db.prepare("SELECT snapshot_json, version FROM project_state WHERE project_id = ?").get(projectId);
if (!row) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}
const snapshot = JSON.parse(row.snapshot_json);
const list = snapshot[collection] || [];
const idx = list.findIndex((o) => o.id === objectId);
if (idx === -1) {
  console.error(`Объект с id "${objectId}" не найден в ${collection} проекта "${projectId}".`);
  process.exit(1);
}
const removed = list[idx];
console.log("Удаляю:", JSON.stringify(removed));
list.splice(idx, 1);
snapshot[collection] = list;

const nextVersion = (row.version || 0) + 1;
db.prepare(
  `UPDATE project_state SET snapshot_json = ?, version = ?, updated_by = ?, updated_at = datetime('now') WHERE project_id = ?`
).run(JSON.stringify(snapshot), nextVersion, "admin (server script)", projectId);

console.log(`Готово. Версия проекта "${projectId}" теперь ${nextVersion}.`);
