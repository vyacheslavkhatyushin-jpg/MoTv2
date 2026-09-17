/*
Массовая чистка объектов без id — по одному через delete-object.js
неудобно и рискованно (после каждого удаления индексы коллекции
сдвигаются, легко промахнуться при большом количестве записей). Этот
скрипт удаляет все id-less записи проекта (по всем 4 коллекциям, либо по
одной — см. --collection) за один проход и одно сохранение, поэтому
индексы не успевают "поехать" между удалениями.

См. find-idless-objects.js, чтобы сначала посмотреть, что вообще есть во
всех проектах, и docs/emergency-cli-scripts.md — как эти записи вообще
появились (переходный период 11-15.09.2026, до того как в mergeCollection
появился мёрдж по id).

Без --yes — только показывает, что будет удалено, ничего не трогает.

Usage:
  node remove-idless-objects.js <projectId> [--collection cables|equipment|marks|patches] [--yes]

Example:
  node remove-idless-objects.js apk                     # что удалится, по всем коллекциям
  node remove-idless-objects.js apk --yes                # удалить по всем коллекциям
  node remove-idless-objects.js opk --collection patches --yes
*/
const { COLLECTIONS, loadProject, saveProject } = require("./lib/snapshot-store");

const [, , projectId, ...rest] = process.argv;
const yes = rest.includes("--yes");
const collectionFlagIdx = rest.indexOf("--collection");
const onlyCollection = collectionFlagIdx !== -1 ? rest[collectionFlagIdx + 1] : null;

if (!projectId || (onlyCollection && !COLLECTIONS.includes(onlyCollection))) {
  console.error(`Usage: node remove-idless-objects.js <projectId> [--collection ${COLLECTIONS.join("|")}] [--yes]`);
  process.exit(1);
}

const project = loadProject(projectId);
if (!project) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}

const collectionsToCheck = onlyCollection ? [onlyCollection] : COLLECTIONS;
let totalRemoved = 0;
for (const collection of collectionsToCheck) {
  const list = project.snapshot[collection] || [];
  const kept = [];
  const removed = [];
  for (const obj of list) {
    if (obj.id) kept.push(obj);
    else removed.push(obj);
  }
  if (!removed.length) continue;
  for (const obj of removed) {
    console.log(`[${collection}] удаляю: ${JSON.stringify({ label: obj.label, createdBy: obj.createdBy, createdAt: obj.createdAt })}`);
  }
  totalRemoved += removed.length;
  if (yes) project.snapshot[collection] = kept;
}

if (!totalRemoved) {
  console.log(`В проекте "${projectId}"${onlyCollection ? ` (${onlyCollection})` : ""} объектов без id не найдено.`);
  process.exit(0);
}

if (!yes) {
  console.log(`\nЭто только предпросмотр — ничего не удалено. Найдено к удалению: ${totalRemoved}.`);
  console.log(`Чтобы удалить по-настоящему:\n  node remove-idless-objects.js ${projectId}${onlyCollection ? ` --collection ${onlyCollection}` : ""} --yes`);
  process.exit(0);
}

const nextVersion = saveProject(projectId, project.snapshot, project.version, "admin (server script)");
console.log(`\nУдалено объектов без id: ${totalRemoved}. Версия проекта "${projectId}" теперь ${nextVersion}.`);
