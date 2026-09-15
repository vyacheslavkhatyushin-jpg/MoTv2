/*
Ручное удаление одного объекта (кабель/оборудование/метка/заплатка)
напрямую из project_state.snapshot_json — на случай, когда обычное
удаление через интерфейс не срабатывает (например, дублирующиеся объекты
с одинаковой подписью, накладывающиеся в 3D и не разбираемые кликом, или
объект вообще без id — такой сервер молча пропускает при обычном
сохранении, поскольку любое id-based сравнение для него бессмысленно).

Бьёт по id (обычный случай) либо по --index N (позиция в массиве —
единственный надёжный способ для записей без id; номер берётся из
вывода list-marks.js). Версию снапшота увеличивает, как обычное
сохранение, чтобы не путать с параллельной правкой из интерфейса.

Usage:
  node delete-object.js <projectId> <collection> <objectId>
  node delete-object.js <projectId> <collection> --index <N>
  collection: cables | equipment | marks | patches

Example:
  node list-marks.js apk "ODF-24"     # найти id или index
  node delete-object.js apk marks m_abc123
  node delete-object.js apk marks --index 4
*/
const db = require("./db");

const [, , projectId, collection, ...rest] = process.argv;
const VALID = new Set(["cables", "equipment", "marks", "patches"]);

let byIndex = null;
let objectId = null;
if (rest[0] === "--index") {
  byIndex = parseInt(rest[1], 10);
} else {
  objectId = rest[0];
}

if (!projectId || !VALID.has(collection) || (byIndex === null && !objectId) || (byIndex !== null && Number.isNaN(byIndex))) {
  console.error("Usage: node delete-object.js <projectId> <cables|equipment|marks|patches> <objectId>");
  console.error("   or: node delete-object.js <projectId> <cables|equipment|marks|patches> --index <N>");
  process.exit(1);
}

const row = db.prepare("SELECT snapshot_json, version FROM project_state WHERE project_id = ?").get(projectId);
if (!row) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}
const snapshot = JSON.parse(row.snapshot_json);
const list = snapshot[collection] || [];
const idx = byIndex !== null ? byIndex : list.findIndex((o) => o.id === objectId);
if (idx === -1 || idx === undefined || idx < 0 || idx >= list.length) {
  console.error(
    byIndex !== null
      ? `Индекс ${byIndex} вне диапазона (в ${collection} проекта "${projectId}" всего ${list.length} записей).`
      : `Объект с id "${objectId}" не найден в ${collection} проекта "${projectId}".`
  );
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
