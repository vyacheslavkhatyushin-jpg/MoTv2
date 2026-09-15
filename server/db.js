const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "app.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Отдельная append-only таблица: кто/когда удалил кабель/оборудование/
-- метку/заплатку. Хранится отдельно от project_state, а не внутри
-- снапшота, по двум причинам: (1) пишется сразу в момент удаления, не
-- дожидаясь нажатия "Сохранить в проект", и не теряется, если человек
-- закрыл вкладку не сохранившись; (2) не может быть случайно стёрта или
-- переписана при конфликте версий/перезаписи снапшота.
CREATE TABLE IF NOT EXISTS deletion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  label TEXT,
  created_by TEXT,
  created_at TEXT,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deletion_log_project
  ON deletion_log(project_id, deleted_at DESC);

-- Мониторинг оборудования (см. docs/monitoring-plan.md). monitor_status —
-- кэш текущего состояния каждого отслеживаемого объекта, перезаписывается
-- на каждый опрос; источник правды для подсветки на 3D-модели.
CREATE TABLE IF NOT EXISTS monitor_status (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  equipment_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('up','down','degraded','unknown')),
  last_checked_at TEXT,
  last_change_at TEXT,
  latency_ms REAL,
  person_count INTEGER,
  vehicle_count INTEGER,
  raw_metrics_json TEXT,
  PRIMARY KEY (project_id, equipment_id)
);

-- Append-only лог аварий/отключений — отдельно от monitor_status по той же
-- логике, что и deletion_log: пишется сразу в момент смены состояния и не
-- может быть случайно перезаписан при следующем опросе.
CREATE TABLE IF NOT EXISTS monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  equipment_id TEXT NOT NULL,
  equipment_label TEXT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_sec INTEGER,
  acknowledged_by TEXT,
  acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitor_events_project
  ON monitor_events(project_id, started_at DESC);

-- Эфемерная очередь "новая метка зарегистрировалась на считывателе"
-- (Этап 4, SPPD/SBeacon). Ряды тут живут секунды: sppd-worker пишет по
-- одному на каждый замеченный рост счётчика меток, server.js на очередном
-- цикле рассылки читает свежие (см. lastTagPulseSent) и шлёт клиентам
-- разовую белую вспышку (spawnMonitorTagPulse), затем сам подчищает
-- старые ряды таймером — состояние тут не нужно хранить долго.
CREATE TABLE IF NOT EXISTS monitor_tag_pulses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  equipment_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_monitor_tag_pulses_project
  ON monitor_tag_pulses(project_id, created_at);

-- Подключение к SPPD для этого проекта (Этап 4). У каждой шахты (apk/ipk/
-- opk) — свой физический сервер SPPD с собственным логином/паролем, поэтому
-- это не общие переменные окружения одного воркера, а настройка на проект,
-- задаётся через UI админом (см. server/routes/projects.js). Пароль хранится
-- как есть (без хеширования) — он нужен воркеру для живого логина на SPPD,
-- не для проверки; отдаётся клиенту только сам факт настройки, не значение
-- (см. GET .../monitor/sppd-config).
CREATE TABLE IF NOT EXISTS project_sppd_config (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
