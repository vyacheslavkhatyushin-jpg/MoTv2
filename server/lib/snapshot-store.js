/*
Общая логика для аварийных CLI-скриптов (list-objects.js, delete-object.js
и т.п.) — читать/писать project_state.snapshot_json напрямую, без API и
без интерфейса, на случай если он подведёт. Один источник правды для всех
таких скриптов, чтобы не разойтись в деталях (например, в том, как считать
следующую версию или что делать с объектами без id).
*/
const db = require("../db");

const COLLECTIONS = ["cables", "equipment", "marks", "patches"];

function loadProject(projectId) {
  const row = db.prepare("SELECT snapshot_json, version FROM project_state WHERE project_id = ?").get(projectId);
  if (!row) return null;
  return { snapshot: JSON.parse(row.snapshot_json), version: row.version || 0 };
}

function saveProject(projectId, snapshot, currentVersion, updatedBy) {
  const nextVersion = (currentVersion || 0) + 1;
  db.prepare(
    `UPDATE project_state SET snapshot_json = ?, version = ?, updated_by = ?, updated_at = datetime('now') WHERE project_id = ?`
  ).run(JSON.stringify(snapshot), nextVersion, updatedBy, projectId);
  return nextVersion;
}

// index — позиция в массиве, а не порядковый номер среди отфильтрованных:
// это то, что delete-object.js принимает через --index — единственный
// надёжный способ адресовать запись без id (бывают такие, обычно из
// старых/повреждённых данных — mergeCollection на сервере такие id-less
// записи при обычном сохранении молча пропускает, поэтому обычное
// удаление через интерфейс на них не действует).
function listCollection(snapshot, collection, labelSubstring) {
  const list = snapshot[collection] || [];
  return list
    .map((obj, index) => ({ obj, index }))
    .filter(({ obj }) => !labelSubstring || (obj.label || "").includes(labelSubstring));
}

function removeFromCollection(snapshot, collection, { id, index }) {
  const list = snapshot[collection] || [];
  const idx = index !== null && index !== undefined ? index : list.findIndex((o) => o.id === id);
  if (idx === -1 || idx === undefined || idx < 0 || idx >= list.length) return null;
  const [removed] = list.splice(idx, 1);
  snapshot[collection] = list;
  return removed;
}

module.exports = { COLLECTIONS, loadProject, saveProject, listCollection, removeFromCollection };
