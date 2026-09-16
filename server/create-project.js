/*
Создать новый проект (или переименовать существующий) — та же операция, что
`seed.js project`, вынесенная в отдельный скрипт для симметрии с
delete-project.js. Разовая операция администратора, поэтому только CLI —
кнопки на это в интерфейсе нет.

Usage:
  node create-project.js <id> <name>

id становится частью URL (/<id>) — используйте короткий понятный слаг.
Если проект с таким id уже есть, команда просто обновляет его название
(id менять нельзя — он часть уже сохранённых ссылок/URL).

Example:
  node create-project.js shaft-1 "Шахта №1"
*/
const db = require("./db");
const { logAudit } = require("./lib/audit");

const [, , id, name] = process.argv;
if (!id || !name) {
  console.error("Usage: node create-project.js <id> <name>");
  process.exit(1);
}

const existing = db.prepare("SELECT name FROM projects WHERE id = ?").get(id);
db.prepare(
  `INSERT INTO projects (id, name) VALUES (?, ?)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name`
).run(id, name);

const actor = process.env.USER || "cli";
if (existing) {
  logAudit({ actor, projectId: id, action: "project.rename", entityType: "project", entityId: id, entityLabel: name, details: { from: existing.name, to: name } });
  console.log(`Проект "${id}" переименован: "${existing.name}" → "${name}".`);
} else {
  logAudit({ actor, projectId: id, action: "project.create", entityType: "project", entityId: id, entityLabel: name });
  console.log(`Проект "${id}" ("${name}") создан. Доступен по адресу /${id}`);
}
