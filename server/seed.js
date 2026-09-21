/*
Usage:
  node seed.js user <username> <password> <viewer|engineer|supervisor|admin>
  node seed.js project <id> <name>

Examples:
  node seed.js user admin "S3cure-Pass!" admin
  node seed.js project shaft-1 "Шахта №1"
*/
const bcrypt = require("bcryptjs");
const db = require("./db");

const [, , cmd, ...args] = process.argv;

if (cmd === "user") {
  const [username, password, role] = args;
  if (!username || !password || !["viewer", "engineer", "supervisor", "admin"].includes(role)) {
    console.error("Usage: node seed.js user <username> <password> <viewer|engineer|supervisor|admin>");
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`
  ).run(username, hash, role);
  console.log(`User "${username}" saved with role "${role}".`);
} else if (cmd === "project") {
  const [id, name] = args;
  if (!id || !name) {
    console.error("Usage: node seed.js project <id> <name>");
    process.exit(1);
  }
  db.prepare(
    `INSERT INTO projects (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`
  ).run(id, name);
  console.log(`Project "${id}" ("${name}") saved. Available at /${id}`);
} else {
  console.error("Unknown command. Use 'user' or 'project'.");
  process.exit(1);
}
