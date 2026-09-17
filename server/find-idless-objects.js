/*
Диагностика: ищет объекты без id во всех проектах сразу, по всем 4
коллекциям (cables/equipment/marks/patches) — такие записи появились из
переходного периода 11-15.09.2026, до того как в mergeCollection (см.
server/routes/projects.js) появился id-based мёрдж по объектам; сервер с
тех пор их тихо не трогает при обычном сохранении (см. комментарий в
mergeCollection), поэтому сами по себе они никуда не денутся.

Только смотрит, ничего не меняет — для самой чистки см.
delete-object.js --index (индекс берётся из вывода этого скрипта; после
каждого удаления индексы конкретной коллекции того же проекта сдвигаются,
поэтому при удалении нескольких объектов из одной коллекции проекта
удаляйте по одному, начиная с САМОГО БОЛЬШОГО индекса).

Usage:
  node find-idless-objects.js
*/
const db = require("./db");
const { COLLECTIONS } = require("./lib/snapshot-store");

const projects = db.prepare("SELECT id FROM projects ORDER BY id").all();

let totalFound = 0;
for (const { id: projectId } of projects) {
  const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  if (!row) continue;
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch (e) {
    console.error(`[${projectId}] не удалось разобрать snapshot_json: ${e.message}`);
    continue;
  }
  for (const collection of COLLECTIONS) {
    const list = snapshot[collection] || [];
    list.forEach((obj, index) => {
      if (obj.id) return;
      totalFound++;
      const summary = { project: projectId, collection, index, label: obj.label, createdBy: obj.createdBy, createdAt: obj.createdAt };
      if (obj.nodes) summary.nodeCount = obj.nodes.length;
      if (obj.method) summary.method = obj.method;
      console.log(JSON.stringify(summary));
    });
  }
}
console.log(totalFound ? `Всего найдено объектов без id: ${totalFound}.` : "Объектов без id не найдено ни в одном проекте.");
