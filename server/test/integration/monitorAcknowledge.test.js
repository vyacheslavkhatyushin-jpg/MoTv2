/*
Подтверждение аварии ("я вижу, разбираюсь") — POST .../monitor/events/:id/
acknowledge (routes/projects.js) + join в GET .../monitor/status
(lib/monitorShared.js attachOpenEventAck). Регрессия на роль (viewer не
должен уметь подтверждать) и на то, что acknowledged_by реально доезжает
до ответа GET /monitor/status, который читает статус-бар на клиенте.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../../testHelpers/spawnServer");
const { createUser, createProject, seedSnapshot, seedMonitorStatus, authHeader } = require("../../testHelpers/seed");

function seedOpenEvent(db, projectId, equipmentId, label) {
  const info = db
    .prepare(
      `INSERT INTO monitor_events (project_id, equipment_id, equipment_label, from_state, to_state, started_at)
       VALUES (?, ?, ?, 'up', 'down', datetime('now'))`
    )
    .run(projectId, equipmentId, label);
  return info.lastInsertRowid;
}

test("подтверждение аварии", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const viewer = createUser(server.db, { username: "ack-viewer", role: "viewer" });
  const engineer = createUser(server.db, { username: "ack-engineer", role: "engineer" });

  createProject(server.db, { id: "ack-proj", name: "x" });
  seedSnapshot(server.db, "ack-proj", {
    equipment: [{ id: "eq1", label: "МАП-1", shape: "sensor", monitorMethod: "ping", ip: "10.0.0.1" }],
  });
  seedMonitorStatus(server.db, "ack-proj", "eq1", { state: "down" });
  const eventId = seedOpenEvent(server.db, "ack-proj", "eq1", "МАП-1");

  await t.test("GET /monitor/status: событие не подтверждено — event_id есть, acknowledged_by нет", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/ack-proj/monitor/status`, { headers: authHeader(engineer) });
    const body = await resp.json();
    const row = body.status.find((r) => r.equipment_id === "eq1");
    assert.equal(row.event_id, eventId);
    assert.equal(row.acknowledged_by, null);
  });

  await t.test("viewer не может подтверждать — 403", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/ack-proj/monitor/events/${eventId}/acknowledge`, {
      method: "POST", headers: authHeader(viewer),
    });
    assert.equal(resp.status, 403);
  });

  await t.test("engineer подтверждает — 200, acknowledgedBy = его логин", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/ack-proj/monitor/events/${eventId}/acknowledge`, {
      method: "POST", headers: authHeader(engineer),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.acknowledgedBy, "ack-engineer");
  });

  await t.test("GET /monitor/status теперь отдаёт acknowledged_by", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/ack-proj/monitor/status`, { headers: authHeader(engineer) });
    const body = await resp.json();
    const row = body.status.find((r) => r.equipment_id === "eq1");
    assert.equal(row.acknowledged_by, "ack-engineer");
    assert.ok(row.acknowledged_at);
  });

  await t.test("повторное подтверждение другим человеком — не перезаписывает актёра", async () => {
    const other = createUser(server.db, { username: "ack-other", role: "admin" });
    const resp = await fetch(`${server.baseUrl}/api/projects/ack-proj/monitor/events/${eventId}/acknowledge`, {
      method: "POST", headers: authHeader(other),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.alreadyAcknowledged, true);
    assert.equal(body.acknowledgedBy, "ack-engineer");
  });

  await t.test("несуществующее событие — 404", async () => {
    const resp = await fetch(`${server.baseUrl}/api/projects/ack-proj/monitor/events/999999/acknowledge`, {
      method: "POST", headers: authHeader(engineer),
    });
    assert.equal(resp.status, 404);
  });
});
