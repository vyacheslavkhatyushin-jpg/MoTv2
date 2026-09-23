/*
Периодическая (и ручная — см. cleanup-orphaned-monitor-data.js) чистка
"осиротевших" строк в таблицах, ссылающихся на equipment_id как на строку
внутри project_state.snapshot_json, БЕЗ настоящего FK (SQLite не умеет
ссылаться внутрь JSON-колонки — см. docs/db-schema.md, раздел про этот
компромисс). Удаление оборудования из модели/смена его id/выключение
мониторинга не подчищает monitor_status/monitor_events/monitor_tag_pulses
само по себе — раньше это накапливалось годами и давало расхождения на
странице "Мониторинг" (см. историю фикса getMonitoredEquipmentIds в
lib/monitorShared.js — тот фикс на ЧТЕНИИ, эта чистка — на ХРАНЕНИИ, чтобы
таблицы не пухли бесконечно; ни одна из них не нужна другой).

tickets.equipment_id ТОЖЕ не FK и тоже может осиротеть — но тикеты НЕ
чистим: это реальная история работы, а не кэш состояния, и она не должна
исчезать вместе с объектом (equipment_label уже сохранён на тикете как
снимок на момент создания, тикет остаётся осмысленным сам по себе).
*/
const db = require("../db");
const { logAudit } = require("./audit");

function loadValidEquipmentIds(projectId) {
  const row = db.prepare("SELECT snapshot_json FROM project_state WHERE project_id = ?").get(projectId);
  if (!row) return null; // проект без снимка (или уже удалён) — не наш случай
  try {
    return new Set((JSON.parse(row.snapshot_json).equipment || []).map((eq) => eq.id));
  } catch (e) {
    console.error(`[cleanupOrphanedData] bad snapshot_json for project ${projectId}:`, e.message);
    return null;
  }
}

// Один проект — что осиротело и (опционально) удаление. dryRun:true — только
// посчитать, ничего не трогать (используется и CLI-превью, и периодическим
// запуском для лога перед фактическим удалением).
function findOrphanedForProject(projectId) {
  const validIds = loadValidEquipmentIds(projectId);
  if (!validIds) return null;

  const statusIds = db.prepare("SELECT equipment_id FROM monitor_status WHERE project_id = ?").all(projectId).map((r) => r.equipment_id);
  const orphanIds = [...new Set(statusIds)].filter((eid) => !validIds.has(eid));
  if (!orphanIds.length) return { projectId, orphanIds: [], eventsCount: 0, pulsesCount: 0 };

  const placeholders = orphanIds.map(() => "?").join(",");
  const eventsCount = db
    .prepare(`SELECT COUNT(*) c FROM monitor_events WHERE project_id = ? AND equipment_id IN (${placeholders})`)
    .get(projectId, ...orphanIds).c;
  const pulsesCount = db
    .prepare(`SELECT COUNT(*) c FROM monitor_tag_pulses WHERE project_id = ? AND equipment_id IN (${placeholders})`)
    .get(projectId, ...orphanIds).c;

  return { projectId, orphanIds, eventsCount, pulsesCount };
}

const deleteForIds = db.transaction((projectId, ids) => {
  for (const eid of ids) {
    db.prepare("DELETE FROM monitor_status WHERE project_id = ? AND equipment_id = ?").run(projectId, eid);
    db.prepare("DELETE FROM monitor_events WHERE project_id = ? AND equipment_id = ?").run(projectId, eid);
    db.prepare("DELETE FROM monitor_tag_pulses WHERE project_id = ? AND equipment_id = ?").run(projectId, eid);
  }
});

// projectId — необязателен (все проекты по умолчанию); dryRun — только
// найти и посчитать, apply=false. actor — для audit_log ("cron" для
// периодического запуска, логин админа для ручного через CLI/будущий UI).
function runCleanup({ projectId, dryRun = false, actor = "cron" } = {}) {
  const projects = projectId
    ? [{ id: projectId }]
    : db.prepare("SELECT id FROM projects ORDER BY id").all();

  const results = [];
  let totalOrphanIds = 0, totalEvents = 0, totalPulses = 0;

  for (const { id: pid } of projects) {
    const found = findOrphanedForProject(pid);
    if (!found || !found.orphanIds.length) continue;
    results.push(found);
    totalOrphanIds += found.orphanIds.length;
    totalEvents += found.eventsCount;
    totalPulses += found.pulsesCount;
    if (!dryRun) deleteForIds(pid, found.orphanIds);
  }

  if (!dryRun && totalOrphanIds > 0) {
    logAudit({
      actor,
      action: "system.cleanup.orphaned_monitor_data",
      entityType: "monitor_status",
      details: {
        projects: results.map((r) => ({ projectId: r.projectId, equipmentIds: r.orphanIds, eventsRemoved: r.eventsCount, pulsesRemoved: r.pulsesCount })),
        totalEquipmentIds: totalOrphanIds, totalEventsRemoved: totalEvents, totalPulsesRemoved: totalPulses,
      },
    });
  }

  return { results, totalOrphanIds, totalEvents, totalPulses };
}

module.exports = { findOrphanedForProject, runCleanup };
