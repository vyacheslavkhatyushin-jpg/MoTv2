/*
Регрессия на "опять подвисли старые данные" (см. историю сессии) через
реальный HTTP-роут, а не напрямую функцию — GET /:id/monitor/status должен
отдавать только оборудование, которое ДЕЙСТВИТЕЛЬНО сейчас мониторится в
текущем снимке проекта, даже если в monitor_status накопились строки по
удалённому/переименованному/отключённому оборудованию.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, authHeader } = require("../../testHelpers/seed");

test("GET /:id/monitor/status фильтрует осиротевшие строки", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const user = createUser(server.db, { username: "viewer1", role: "viewer" });
  createProject(server.db, { id: "proj-status", name: "x" });
  server.db.prepare(`INSERT INTO project_state (project_id, snapshot_json, version) VALUES (?, ?, 1)`).run(
    "proj-status",
    JSON.stringify({
      equipment: [
        { id: "eq_alive", label: "МАП-1", monitorMethod: "ping", ip: "10.0.0.1" },
        { id: "eq_disabled_now", label: "МАП-2", monitorMethod: "none" },
      ],
      cables: [], marks: [], patches: [],
    })
  );
  const insertStatus = server.db.prepare(
    `INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))`
  );
  insertStatus.run("proj-status", "eq_alive");
  insertStatus.run("proj-status", "eq_disabled_now"); // мониторинг выключен, но старая строка осталась
  insertStatus.run("proj-status", "eq_deleted_long_ago"); // оборудования такого в модели уже нет

  const resp = await fetch(`${server.baseUrl}/api/projects/proj-status/monitor/status`, { headers: authHeader(user) });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(
    body.status.map((r) => r.equipment_id),
    ["eq_alive"],
    "должна остаться только реально мониторящаяся строка"
  );
});
