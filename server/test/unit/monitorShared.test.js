/*
Юнит-тесты server/lib/monitorShared.js — в основном регрессия на баг из
сессии "опять подвисли старые данные": monitor_status накапливал
"осиротевшие" строки (удалённое/переименованное оборудование, выключенный
мониторинг), а getMonitorStatus/GET .../monitor/status их не фильтровали.
Фикс — getMonitoredEquipmentIds как единственный источник истины,
применяемый на чтении; эти тесты защищают именно это свойство напрямую,
без похода через HTTP/WS.
*/
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let db, monitorShared, dbPath;

before(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mot-unit-")), "test.db");
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || "unit_test_secret";
  db = require("../../db");
  monitorShared = require("../../lib/monitorShared");
});

after(() => {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch (e) {}
});

test("isEquipmentMonitored: ping требует ip", () => {
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "ping", ip: "10.0.0.1" }), true);
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "ping", ip: "" }), false);
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "ping" }), false);
});

test("isEquipmentMonitored: custom требует dataSourceId И sourceAddress", () => {
  assert.equal(
    monitorShared.isEquipmentMonitored({ monitorMethod: "custom", dataSourceId: 1, sourceAddress: "42" }),
    true
  );
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "custom", dataSourceId: 1 }), false);
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "custom", sourceAddress: "42" }), false);
});

test("isEquipmentMonitored: none/snmp/отсутствующий метод — не мониторится", () => {
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "none", ip: "10.0.0.1" }), false);
  assert.equal(monitorShared.isEquipmentMonitored({ monitorMethod: "snmp", ip: "10.0.0.1" }), false);
  assert.equal(monitorShared.isEquipmentMonitored({}), false);
});

test("getMonitoredEquipmentIds: отдаёт только реально мониторящееся оборудование текущего снимка", () => {
  db.prepare("INSERT OR REPLACE INTO projects (id, name) VALUES ('proj-monshared', 'x')").run();
  db.prepare(
    `INSERT INTO project_state (project_id, snapshot_json, version) VALUES ('proj-monshared', ?, 1)
     ON CONFLICT(project_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`
  ).run(
    JSON.stringify({
      equipment: [
        { id: "eq_ping_ok", monitorMethod: "ping", ip: "10.0.0.1" },
        { id: "eq_ping_no_ip", monitorMethod: "ping", ip: "" },
        { id: "eq_custom_ok", monitorMethod: "custom", dataSourceId: 3, sourceAddress: "7" },
        { id: "eq_disabled", monitorMethod: "none" },
      ],
      cables: [], marks: [], patches: [],
    })
  );

  const ids = monitorShared.getMonitoredEquipmentIds("proj-monshared");
  assert.deepEqual([...ids].sort(), ["eq_custom_ok", "eq_ping_ok"]);
});

test("getMonitoredEquipmentIds: регрессия на 'подвисшие данные' — осиротевшие/переименованные/отключённые строки не воскресают", () => {
  db.prepare("INSERT OR REPLACE INTO projects (id, name) VALUES ('proj-ghosts', 'x')").run();
  db.prepare(
    `INSERT INTO project_state (project_id, snapshot_json, version) VALUES ('proj-ghosts', ?, 1)
     ON CONFLICT(project_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`
  ).run(
    JSON.stringify({
      // Реальная модель сейчас — только одно мониторящееся устройство.
      equipment: [{ id: "eq_alive", monitorMethod: "ping", ip: "10.0.0.5" }],
      cables: [], marks: [], patches: [],
    })
  );
  // Но в monitor_status годами копились строки по устройству, которое
  // удалили (eq_deleted), переименовали (id сменился, eq_old_name — призрак
  // старого id) и просто выключили мониторинг, не убрав из модели
  // (eq_alive был бы тут же, но проверяем именно "чужие" строки).
  const insertStatus = db.prepare(
    `INSERT INTO monitor_status (project_id, equipment_id, state, last_checked_at)
     VALUES (?, ?, 'up', datetime('now'))`
  );
  insertStatus.run("proj-ghosts", "eq_deleted");
  insertStatus.run("proj-ghosts", "eq_old_name");
  insertStatus.run("proj-ghosts", "eq_alive");

  const validIds = monitorShared.getMonitoredEquipmentIds("proj-ghosts");
  const rows = db
    .prepare("SELECT equipment_id FROM monitor_status WHERE project_id = ?")
    .all("proj-ghosts")
    .filter((r) => validIds.has(r.equipment_id));

  assert.deepEqual(rows.map((r) => r.equipment_id), ["eq_alive"]);
});

test("getMonitoredEquipmentIds: несуществующий проект — пустой набор, не исключение", () => {
  const ids = monitorShared.getMonitoredEquipmentIds("proj-does-not-exist-xyz");
  assert.equal(ids.size, 0);
});

test("getMonitoredEquipmentIds: битый snapshot_json — пустой набор, не падение", () => {
  db.prepare("INSERT OR REPLACE INTO projects (id, name) VALUES ('proj-broken-json', 'x')").run();
  db.prepare(
    `INSERT INTO project_state (project_id, snapshot_json, version) VALUES ('proj-broken-json', '{not valid json', 1)
     ON CONFLICT(project_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`
  ).run();
  assert.doesNotThrow(() => monitorShared.getMonitoredEquipmentIds("proj-broken-json"));
  assert.equal(monitorShared.getMonitoredEquipmentIds("proj-broken-json").size, 0);
});
