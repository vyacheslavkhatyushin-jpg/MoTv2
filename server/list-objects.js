/*
Аварийная диагностика: печатает объекты (кабели/оборудование/метки/
заплатки) проекта прямо из project_state.snapshot_json — на случай, если
интерфейс редактора недоступен или показывает не то. Используйте вместе
с delete-object.js, чтобы точно опознать и убрать конкретную запись.

Usage:
  node list-objects.js <projectId> <cables|equipment|marks|patches> [labelSubstring]

Examples:
  node list-objects.js apk marks
  node list-objects.js apk marks "ODF-24"
  node list-objects.js apk equipment "MAP"
*/
const { COLLECTIONS, loadProject, listCollection } = require("./lib/snapshot-store");

const [, , projectId, collection, labelSubstring] = process.argv;
if (!projectId || !COLLECTIONS.includes(collection)) {
  console.error(`Usage: node list-objects.js <projectId> <${COLLECTIONS.join("|")}> [labelSubstring]`);
  process.exit(1);
}

const project = loadProject(projectId);
if (!project) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}
const all = project.snapshot[collection] || [];
const filtered = listCollection(project.snapshot, collection, labelSubstring);

if (!filtered.length) {
  console.log(`Ничего не найдено (всего в ${collection}: ${all.length}).`);
  process.exit(0);
}
for (const { obj, index } of filtered) {
  const summary = { index, id: obj.id, label: obj.label, createdBy: obj.createdBy, createdAt: obj.createdAt };
  if (obj.position) summary.position = obj.position;
  if (obj.nodes) summary.nodeCount = obj.nodes.length;
  console.log(JSON.stringify(summary));
}
console.log(`Показано ${filtered.length} из ${all.length} записей в ${collection}.`);
if (all.some((o) => !o.id)) {
  console.log(`Внимание: у части записей отсутствует id (не показан выше) — удалять такие можно только по --index, не по id.`);
}
