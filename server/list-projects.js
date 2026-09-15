/*
Список всех проектов на этом сервере — на случай, если раздел
"Пользователи"/список проектов в интерфейсе недоступен.

Usage:
  node list-projects.js
*/
const db = require("./db");

const rows = db.prepare(
  `SELECT p.id, p.name, p.created_at, s.version, s.updated_by, s.updated_at
   FROM projects p LEFT JOIN project_state s ON s.project_id = p.id
   ORDER BY p.name`
).all();

if (!rows.length) {
  console.log("Проектов пока нет.");
  process.exit(0);
}
for (const r of rows) {
  console.log(JSON.stringify({
    id: r.id, name: r.name, createdAt: r.created_at,
    stateVersion: r.version ?? null, lastSavedBy: r.updated_by ?? null, lastSavedAt: r.updated_at ?? null,
  }));
}
console.log(`Всего проектов: ${rows.length}.`);
