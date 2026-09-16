/*
Безвозвратное удаление проекта целиком — модель, кабели/оборудование/метки/
заплатки, история мониторинга, ЗИП, отчёты по фонарям, пороги и SPPD-
подключение. Кнопки на это в интерфейсе нет намеренно (слишком легко нажать
по ошибке) — только эта команда.

Все связанные таблицы объявлены с `REFERENCES projects(id) ON DELETE CASCADE`
(see db.js), а better-sqlite3 по умолчанию включает `PRAGMA foreign_keys`, так
что реально достаточно одного DELETE из `projects` — но сначала полезно
увидеть, что именно будет стёрто, поэтому без --yes скрипт только печатает
сводку и ничего не удаляет.

Перед реальным удалением стоит сохранить снимок модели на всякий случай:
  node dump-snapshot.js <projectId>

Usage:
  node delete-project.js <projectId>          # только показать, что будет удалено
  node delete-project.js <projectId> --yes    # удалить по-настоящему

Example:
  node delete-project.js shaft-old
  node delete-project.js shaft-old --yes
*/
const db = require("./db");

const [, , projectIdRaw, flag] = process.argv;
if (!projectIdRaw) {
  console.error("Usage: node delete-project.js <projectId> [--yes]");
  process.exit(1);
}
const projectId = projectIdRaw.toLowerCase();
const confirmed = flag === "--yes";

const project = db.prepare("SELECT id, name, created_at FROM projects WHERE id = ?").get(projectId);
if (!project) {
  console.error(`Проект "${projectId}" не найден.`);
  process.exit(1);
}

const counts = {
  "кабели/оборудование/метки/заплатки (снимок модели)": db.prepare("SELECT COUNT(*) c FROM project_state WHERE project_id = ?").get(projectId).c,
  "записи в журнале удалений": db.prepare("SELECT COUNT(*) c FROM deletion_log WHERE project_id = ?").get(projectId).c,
  "статусы мониторинга оборудования": db.prepare("SELECT COUNT(*) c FROM monitor_status WHERE project_id = ?").get(projectId).c,
  "события/аварии мониторинга": db.prepare("SELECT COUNT(*) c FROM monitor_events WHERE project_id = ?").get(projectId).c,
  "импульсы тегов (FieldSense/SPPD)": db.prepare("SELECT COUNT(*) c FROM monitor_tag_pulses WHERE project_id = ?").get(projectId).c,
  "позиции ЗИП": db.prepare("SELECT COUNT(*) c FROM zip_items WHERE project_id = ?").get(projectId).c,
  "заявки на ЗИП": db.prepare("SELECT COUNT(*) c FROM zip_requests WHERE project_id = ?").get(projectId).c,
  "движения по ЗИП": db.prepare("SELECT COUNT(*) c FROM zip_movements WHERE project_id = ?").get(projectId).c,
  "загруженные отчёты по фонарям": db.prepare("SELECT COUNT(*) c FROM lamp_reports WHERE project_id = ?").get(projectId).c,
  "записи фонарей во всех отчётах": db.prepare(
    "SELECT COUNT(*) c FROM lamp_records WHERE report_id IN (SELECT id FROM lamp_reports WHERE project_id = ?)"
  ).get(projectId).c,
};

console.log(`Проект: ${project.name} (${project.id}), создан ${project.created_at}`);
console.log("Будет удалено вместе с проектом:");
for (const [label, n] of Object.entries(counts)) {
  console.log(`  ${label}: ${n}`);
}
console.log("(SPPD-подключение и пороги фиксации аварии для проекта, если настроены, тоже удаляются)");

if (!confirmed) {
  console.log("\nЭто только предпросмотр — ничего не удалено. Чтобы удалить по-настоящему:");
  console.log(`  node delete-project.js ${project.id} --yes`);
  process.exit(0);
}

db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
console.log(`\nПроект "${project.id}" и всё связанное с ним удалено безвозвратно.`);
