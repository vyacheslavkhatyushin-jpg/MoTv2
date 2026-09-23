/*
Юнит-тесты server/lib/cleanupOrphanedData.js — модуль, который теперь
крутится сам раз в сутки в server.js (housekeeping для monitor_status/
monitor_events/monitor_tag_pulses, см. комментарий в самом модуле) и
одновременно остаётся доступен вручную через cleanup-orphaned-monitor-data.js.
*/
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let db, cleanup, dbPath;

before(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mot-cleanup-unit-")), "test.db");
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || "unit_test_secret";
  db = require("../../db");
  cleanup = require("../../lib/cleanupOrphanedData");
});

after(() => {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch (e) {}
});

function seedProject(id, equipmentIds) {
  db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, id);
  db.prepare("INSERT INTO project_state (project_id, snapshot_json, version) VALUES (?, ?, 1)").run(
    id,
    JSON.stringify({ equipment: equipmentIds.map((eid) => ({ id: eid })) })
  );
}

test("dryRun:true — находит осиротевшие строки, ничего не удаляет", () => {
  seedProject("cln-1", ["alive"]);
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))").run("cln-1", "alive");
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))").run("cln-1", "ghost");
  db.prepare("INSERT INTO monitor_events (project_id, equipment_id, to_state, started_at) VALUES (?, ?, 'down', datetime('now'))").run("cln-1", "ghost");

  const { totalOrphanIds, totalEvents } = cleanup.runCleanup({ projectId: "cln-1", dryRun: true });
  assert.equal(totalOrphanIds, 1);
  assert.equal(totalEvents, 1);

  const rows = db.prepare("SELECT equipment_id FROM monitor_status WHERE project_id = ?").all("cln-1");
  assert.deepEqual(rows.map((r) => r.equipment_id).sort(), ["alive", "ghost"], "dryRun не должен ничего удалять");
});

test("dryRun:false — реально удаляет только осиротевшие equipment_id, живое не трогает", () => {
  seedProject("cln-2", ["alive"]);
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))").run("cln-2", "alive");
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'down', datetime('now'))").run("cln-2", "ghost1");
  db.prepare("INSERT INTO monitor_tag_pulses (project_id, equipment_id) VALUES (?, ?)").run("cln-2", "ghost1");

  const { totalOrphanIds } = cleanup.runCleanup({ projectId: "cln-2", dryRun: false, actor: "test" });
  assert.equal(totalOrphanIds, 1);

  const statusRows = db.prepare("SELECT equipment_id FROM monitor_status WHERE project_id = ?").all("cln-2");
  assert.deepEqual(statusRows.map((r) => r.equipment_id), ["alive"]);
  const pulseRows = db.prepare("SELECT equipment_id FROM monitor_tag_pulses WHERE project_id = ?").all("cln-2");
  assert.deepEqual(pulseRows, []);
});

test("реальное удаление пишет запись в audit_log", () => {
  seedProject("cln-3", []);
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))").run("cln-3", "ghost");

  cleanup.runCleanup({ projectId: "cln-3", dryRun: false, actor: "test-audit" });

  const entry = db.prepare("SELECT actor, action FROM audit_log WHERE action = 'system.cleanup.orphaned_monitor_data' AND actor = 'test-audit'").get();
  assert.ok(entry, "должна появиться запись в audit_log");
});

test("dryRun — НЕ пишет в audit_log", () => {
  seedProject("cln-4", []);
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))").run("cln-4", "ghost");

  cleanup.runCleanup({ projectId: "cln-4", dryRun: true, actor: "test-dryrun-no-audit" });

  const entry = db.prepare("SELECT 1 FROM audit_log WHERE actor = 'test-dryrun-no-audit'").get();
  assert.equal(entry, undefined);
});

test("ничего осиротевшего — 0 результатов, без падений", () => {
  seedProject("cln-5", ["alive"]);
  db.prepare("INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at) VALUES (?, ?, 'up', datetime('now'))").run("cln-5", "alive");

  const { totalOrphanIds, results } = cleanup.runCleanup({ projectId: "cln-5", dryRun: false });
  assert.equal(totalOrphanIds, 0);
  assert.deepEqual(results, []);
});

test("тикеты с осиротевшим equipment_id НЕ трогаются (это история, не кэш)", () => {
  seedProject("cln-6", []);
  db.prepare(
    `INSERT INTO tickets (project_id, equipment_id, equipment_label, title, status, created_by)
     VALUES (?, 'ghost-eq', 'Бывший МАП-3', 'Авария', 'new', 'tester')`
  ).run("cln-6");

  cleanup.runCleanup({ projectId: "cln-6", dryRun: false });

  const ticket = db.prepare("SELECT equipment_id, equipment_label FROM tickets WHERE project_id = ?").get("cln-6");
  assert.equal(ticket.equipment_id, "ghost-eq");
  assert.equal(ticket.equipment_label, "Бывший МАП-3");
});
