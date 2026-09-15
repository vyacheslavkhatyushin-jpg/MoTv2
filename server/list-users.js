/*
Список всех пользователей и их ролей — на случай, если панель
"Пользователи" в интерфейсе недоступна (например, все admin-аккаунты
случайно потеряли пароли). Пароли (хеши) не печатаются — это только
просмотр; чтобы задать/сбросить пароль или роль напрямую, используйте
seed.js (он уже это умеет):

  node seed.js user <username> <newPassword> <viewer|editor|admin>

Usage:
  node list-users.js
*/
const db = require("./db");

const rows = db.prepare("SELECT username, role, created_at FROM users ORDER BY username").all();
if (!rows.length) {
  console.log("Пользователей пока нет.");
  process.exit(0);
}
for (const r of rows) {
  console.log(JSON.stringify({ username: r.username, role: r.role, createdAt: r.created_at }));
}
console.log(`Всего пользователей: ${rows.length}.`);
