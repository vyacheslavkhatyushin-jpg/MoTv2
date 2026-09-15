/*
Сохраняет текущий снимок проекта (project_state.snapshot_json) в файл —
резервная копия перед любой рискованной ручной правкой через
delete-object.js. Пишет в volume-директорию рядом с самой БД (server/data),
чтобы файл не потерялся вместе с контейнером.

Usage:
  node dump-snapshot.js <projectId> [outFile]

Example:
  node dump-snapshot.js apk
  node dump-snapshot.js apk data/apk-backup-2026-09-15.json
*/
const fs = require("fs");
const path = require("path");
const { loadProject } = require("./lib/snapshot-store");

const [, , projectId, outFileArg] = process.argv;
if (!projectId) {
  console.error("Usage: node dump-snapshot.js <projectId> [outFile]");
  process.exit(1);
}

const project = loadProject(projectId);
if (!project) {
  console.error(`Проект "${projectId}" не найден или у него нет сохранённого состояния.`);
  process.exit(1);
}

const defaultOut = path.join(
  __dirname, "data",
  `${projectId}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
const outFile = outFileArg || defaultOut;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(project.snapshot, null, 2));
console.log(`Снимок проекта "${projectId}" (версия ${project.version}) сохранён в ${outFile}`);
