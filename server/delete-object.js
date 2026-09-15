/*
Ручное удаление одного объекта (кабель/оборудование/метка/заплатка)
напрямую из project_state.snapshot_json — на случай, когда обычное
удаление через интерфейс не срабатывает (например, дублирующиеся объекты
с одинаковой подписью, накладывающиеся в 3D и не разбираемые кликом, или
объект вообще без id — такой сервер молча пропускает при обычном
сохранении, поскольку любое id-based сравнение для него бессмысленно).

Бьёт по id (обычный случай) либо по --index N (позиция в массиве —
единственный надёжный способ для записей без id; номер берётся из
вывода list-objects.js). Версию снапшота увеличивает, как обычное
сохранение, чтобы не путать с параллельной правкой из интерфейса.

Usage:
  node delete-object.js <projectId> <cables|equipment|marks|patches> <objectId>
  node delete-object.js <projectId> <cables|equipment|marks|patches> --index <N>

Example:
  node list-objects.js apk marks "ODF-24"     # найти id или index
  node delete-object.js apk marks m_abc123
  node delete-object.js apk marks --index 4
*/
const { COLLECTIONS, loadProject, saveProject, removeFromCollection } = require("./lib/snapshot-store");

const [, , projectId, collection, ...rest] = process.argv;

let index = null;
let objectId = null;
if (rest[0] === "--index") {
  index = parseInt(rest[1], 10);
} else {
  objectId = rest[0];
}

if (!projectId || !COLLECTIONS.includes(collection) || (index === null && !objectId) || (index !== null && Number.isNaN(index))) {
  console.error(`Usage: node delete-object.js <projectId> <${COLLECTIONS.join("|")}> <objectId>`);
  console.error(`   or: node delete-object.js <projectId> <${COLLECTIONS.join("|")}> --index <N>`);
  process.exit(1);
}

const project = loadProject(projectId);
if (!project) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}
const removed = removeFromCollection(project.snapshot, collection, { id: objectId, index });
if (!removed) {
  console.error(
    index !== null
      ? `Индекс ${index} вне диапазона в ${collection} проекта "${projectId}".`
      : `Объект с id "${objectId}" не найден в ${collection} проекта "${projectId}".`
  );
  process.exit(1);
}
console.log("Удаляю:", JSON.stringify(removed));
const nextVersion = saveProject(projectId, project.snapshot, project.version, "admin (server script)");
console.log(`Готово. Версия проекта "${projectId}" теперь ${nextVersion}.`);
