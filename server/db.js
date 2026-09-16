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

-- Пороги фиксации аварии — per-project (у шахт разная сеть/оборудование,
-- глобальные env-переменные воркеров одни на все проекты сразу).
--
-- Статус на дашборде/3D-модели всегда живой (сырой результат последнего
-- пинга/SPPD-сигнала) — красим сразу, без задержки. А вот "авария" как
-- событие в monitor_events (то, что считает аптайм/длительности) фиксируется
-- только после ...fail_duration_sec непрерывного простоя — одиночный
-- потерянный пакет или короткий флап не должен создавать запись в истории
-- аварий. Для SPPD это применимо к обоим путям обнаружения "down" —
-- и явному push OnLine:false от считывателя, и обнаруженной тишине
-- (sppd_stale_after_sec — отдельный порог, ЗА СКОЛЬКО тишины мы вообще
-- решаем, что связи нет; sppd_fail_duration_sec — ПОСЛЕ обнаружения "down"
-- любым из двух путей, сколько ещё ждать до записи в историю).
-- Отсутствие строки для проекта = дефолты воркеров ниже; так что добавление
-- этой таблицы само по себе ничего не меняет для проектов, которые никто не
-- настраивал через UI (кнопка "⚙ Пороги", см. server/routes/projects.js).
CREATE TABLE IF NOT EXISTS project_monitor_thresholds (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  ping_timeout_sec INTEGER NOT NULL DEFAULT 1,
  ping_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
  sppd_stale_after_sec INTEGER NOT NULL DEFAULT 120,
  sppd_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
  fs_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
  lamp_fail_after_hours INTEGER NOT NULL DEFAULT 24,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Реестр ЗИП (склад запчастей) + заявки на выдачу — отдельный от 3D-модели
-- модуль (никакой привязки к cables/equipment шахты). ЗИП только
-- расходуется, возвратов на склад не бывает.
--
-- zip_items — справочник позиций. qty_on_hand/qty_reserved — кэш текущего
-- состояния для быстрого чтения; source of truth по остаткам — append-only
-- zip_movements (та же логика, что у deletion_log/monitor_events: движение
-- пишется в момент операции и не может быть тихо переписано).
-- qty_available (в API, не в таблице) = qty_on_hand - qty_reserved.
CREATE TABLE IF NOT EXISTS zip_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'шт',
  manufacturer TEXT,
  part_number TEXT,
  description TEXT,
  location TEXT,
  min_qty INTEGER NOT NULL DEFAULT 0,
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  qty_reserved INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_zip_items_project ON zip_items(project_id, name);

-- zip_requests — заявка инженера на выдачу. Резерв (qty_reserved у
-- позиции) происходит не при подаче заявки, а при одобрении — иначе любой
-- инженер мог бы заявками заблокировать весь остаток до решения админа.
-- pending → approved (резерв взят) → issued (списано со склада, резерв
-- снят) либо rejected/cancelled (резерв, если был взят, освобождается).
CREATE TABLE IF NOT EXISTS zip_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES zip_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK(qty > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','issued','cancelled')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  issued_by TEXT,
  issued_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_zip_requests_project ON zip_requests(project_id, requested_at DESC);

-- zip_movements — append-only лог изменений остатка: 'receipt' (приход на
-- склад), 'issue' (выдача по заявке — request_id заполнен), 'adjustment'
-- (ручная корректировка при инвентаризации/списании порчи).
CREATE TABLE IF NOT EXISTS zip_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES zip_items(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('receipt','issue','adjustment')),
  request_id INTEGER REFERENCES zip_requests(id),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_zip_movements_item ON zip_movements(item_id, created_at DESC);

-- Фонари: статистика работоспособности по отчёту "Текущие местоположение"
-- (SPPD/SBeacon), загружается вручную (.xls/.xlsx) — см. server/lib/lampReportParser.js.
-- lamp_reports — одна строка на загрузку; is_broken на записи считается один
-- раз при загрузке относительно generated_at ИЗ САМОГО ОТЧЁТА (не текущего
-- времени сервера) и порога lamp_fail_after_hours на момент загрузки —
-- поэтому история прошлых отчётов не "переобувается" задним числом при
-- смене порога в "⚙ Пороги".
CREATE TABLE IF NOT EXISTS lamp_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  source_filename TEXT,
  total_count INTEGER NOT NULL,
  ok_count INTEGER NOT NULL,
  broken_count INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lamp_reports_project ON lamp_reports(project_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS lamp_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES lamp_reports(id) ON DELETE CASCADE,
  tab_number TEXT NOT NULL,
  full_name TEXT NOT NULL,
  position TEXT,
  department TEXT,
  organization TEXT,
  lamp_id TEXT,
  reader TEXT,
  last_seen_at TEXT NOT NULL,
  is_broken INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lamp_records_report ON lamp_records(report_id);

-- Единый журнал действий — вход в систему, правки/создание/удаление
-- объектов модели, управление пользователями/проектами/ЗИП/фонарями/
-- порогами/SPPD. project_id — ON DELETE SET NULL (не CASCADE): запись о
-- том, что проект X удалён, должна сама выжить после удаления проекта, а
-- не исчезнуть вместе с ним.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  entity_label TEXT,
  details TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC);
`);

// Одноразовая миграция: ping_fail_threshold (счётчик подряд неудач) заменён
// на ping_fail_duration_sec (длительность простоя) — семантика поля другая,
// не просто переименование. Таблица прожила всего несколько часов до этой
// правки и заведомо пуста на всех деплоях, поэтому проще пересоздать её с
// новой схемой, чем городить преобразование значений.
const monitorThresholdsCols = db.prepare("PRAGMA table_info(project_monitor_thresholds)").all();
if (monitorThresholdsCols.some((c) => c.name === "ping_fail_threshold")) {
  db.exec("DROP TABLE project_monitor_thresholds");
  db.exec(`
    CREATE TABLE project_monitor_thresholds (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      ping_timeout_sec INTEGER NOT NULL DEFAULT 1,
      ping_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
      sppd_stale_after_sec INTEGER NOT NULL DEFAULT 120,
      sppd_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
      fs_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
      lamp_fail_after_hours INTEGER NOT NULL DEFAULT 24,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} else {
  // Чисто добавочные миграции (в отличие от переименования выше) — здесь
  // уже могли быть настоящие сохранённые пороги, поэтому ADD COLUMN с
  // дефолтом, а не пересоздание таблицы.
  if (!monitorThresholdsCols.some((c) => c.name === "sppd_fail_duration_sec")) {
    db.exec("ALTER TABLE project_monitor_thresholds ADD COLUMN sppd_fail_duration_sec INTEGER NOT NULL DEFAULT 300");
  }
  if (!monitorThresholdsCols.some((c) => c.name === "fs_fail_duration_sec")) {
    db.exec("ALTER TABLE project_monitor_thresholds ADD COLUMN fs_fail_duration_sec INTEGER NOT NULL DEFAULT 300");
  }
  if (!monitorThresholdsCols.some((c) => c.name === "lamp_fail_after_hours")) {
    db.exec("ALTER TABLE project_monitor_thresholds ADD COLUMN lamp_fail_after_hours INTEGER NOT NULL DEFAULT 24");
  }
}

module.exports = db;
