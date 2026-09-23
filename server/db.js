const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "app.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
-- Роли: viewer (только чтение) < engineer (редактирование модели/тикетов/
-- ЗИП-заявок — бывший "editor", переименован при добавлении supervisor,
-- см. миграцию ниже) < supervisor (всё, что может admin, КРОМЕ разделов
-- "Настройки" → Пользователи и Справочники) < admin (полные права).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','engineer','supervisor','admin')),
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

-- Эфемерная очередь "новая метка зарегистрировалась на считывателе".
-- Ряды тут живут секунды: custom-monitor-worker.js (через
-- server/lib/monitorShared.js emitTagPulse) пишет по одному на каждое
-- событие tagPulseEvent из настроенного источника, server.js на очередном
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

-- Пороги фиксации аварии — per-project (у шахт разная сеть/оборудование,
-- глобальные env-переменные воркеров одни на все проекты сразу).
--
-- Статус на дашборде/3D-модели всегда живой (сырой результат последнего
-- пинга/сигнала) — красим сразу, без задержки. А вот "авария" как
-- событие в monitor_events (то, что считает аптайм/длительности) фиксируется
-- только после ...fail_duration_sec непрерывного простоя — одиночный
-- потерянный пакет или короткий флап не должен создавать запись в истории
-- аварий. custom_stale_after_sec/custom_fail_duration_sec (добавляются
-- миграцией ниже) — тот же принцип для custom-monitor-worker.js: отдельный
-- порог, ЗА СКОЛЬКО тишины мы вообще решаем, что связи нет, и отдельный —
-- ПОСЛЕ обнаружения "down", сколько ещё ждать до записи в историю.
-- Отсутствие строки для проекта = дефолты воркеров ниже; так что добавление
-- этой таблицы само по себе ничего не меняет для проектов, которые никто не
-- настраивал через UI (кнопка "⚙ Пороги", см. server/routes/projects.js).
CREATE TABLE IF NOT EXISTS project_monitor_thresholds (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  ping_timeout_sec INTEGER NOT NULL DEFAULT 1,
  ping_fail_duration_sec INTEGER NOT NULL DEFAULT 300,
  lamp_fail_after_hours INTEGER NOT NULL DEFAULT 24,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Пер-формные переопределения порогов (модуль "Настройки" → Пороги) —
-- необязательные, per (project_id, shape). NULL в любой из колонок значит
-- "использовать дефолт проекта" (project_monitor_thresholds.ping_fail_duration_sec
-- для оборудования с monitorMethod:"ping", .custom_stale_after_sec/
-- .custom_fail_duration_sec — для monitorMethod:"custom"). shape — не
-- конкретный метод мониторинга: одна и та же форма (например, IILB) в
-- разных проектах может быть настроена и как ping, и как custom, поэтому
-- воркеры сами выбирают нужную колонку под свой метод, а не эта таблица.
CREATE TABLE IF NOT EXISTS project_shape_thresholds (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shape TEXT NOT NULL,
  stale_after_sec INTEGER,
  fail_duration_sec INTEGER,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, shape)
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

-- Общесерверные сетевые настройки (не привязаны к какой-то одной фиче) —
-- singleton-строка. Сейчас тут только исходящий HTTP(S)-прокси (см.
-- server/lib/proxy.js, Настройки → Сеть) — на разных площадках может
-- быть разный корпоративный прокси или его не быть вовсе, поэтому это
-- настройка через UI, а не .env/docker-compose.yml (те тоже продолжают
-- работать как фолбэк, если тут пусто — см. server/lib/proxy.js).
CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  outbound_proxy_url TEXT,
  updated_by TEXT,
  updated_at TEXT
);
INSERT OR IGNORE INTO server_settings (id) VALUES (1);

-- Автобэкап БД (см. server/backup/run-backup.js + server/backup-worker.js) —
-- singleton-строка (id всегда 1), настраивается в Настройки → Резервное
-- копирование. И SSH-ключ, и Google Drive OAuth-токен подключаются целиком
-- через UI (см. server/routes/backup.js, /ssh/save и /gdrive/connect) и
-- хранятся тут же, в БД — осознанное исключение из "секреты только в
-- .env", ради простоты настройки; отдельная миграция ниже добавляет под
-- это колонки (их нет в CREATE TABLE — появились позже).
CREATE TABLE IF NOT EXISTS backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  schedule_time TEXT NOT NULL DEFAULT '03:00',
  local_retention_count INTEGER NOT NULL DEFAULT 14,
  target_ssh_enabled INTEGER NOT NULL DEFAULT 0,
  target_gdrive_enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);
INSERT OR IGNORE INTO backup_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','partial','failed')),
  triggered_by TEXT NOT NULL,
  local_file TEXT,
  local_size_bytes INTEGER,
  targets_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at DESC);

-- Тикетинг: устранение аварий/находок эксплуатацией. equipment_id и
-- monitor_event_id — оба nullable: тикет может быть общим (без привязки к
-- конкретному оборудованию) или заведён вручную, не по факту аварии из
-- monitor_events. due_at считается один раз в момент назначения исполнителя
-- (assigned_at), по текущему на тот момент SLA-порогу приоритета
-- (project_monitor_thresholds.ticket_sla_*_hours) — как и lamp_records,
-- сознательно не пересчитывается задним числом при смене порога позже.
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  equipment_id TEXT,
  equipment_label TEXT,
  monitor_event_id INTEGER REFERENCES monitor_events(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','in_progress','on_review','closed','cancelled')),
  assignee TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at TEXT,
  due_at TEXT,
  closed_by TEXT,
  closed_at TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee, status);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);

-- Фото хранятся как BLOB прямо в SQLite (не на диске) — так они попадают в
-- тот же volume/бэкап, что и вся остальная база, без отдельного тома в
-- docker-compose. comment_id nullable — фото можно прикрепить и просто к
-- тикету, и к конкретному комментарию.
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES ticket_comments(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  data BLOB NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);

-- Справочники объектов — общие на всю систему (не per-project), в отличие
-- от project_sppd_config/project_monitor_thresholds выше. Сама модель шахты
-- (project_state.snapshot_json) остаётся как есть — оборудование получает
-- лишь ещё одно поле profileId, как уже есть shape/monitorMethod; ключ
-- атрибута/тип кабеля используется как литеральное значение внутри JSON
-- (raw_metrics_json, equipment.cableType и т.п.), поэтому key НЕЛЬЗЯ
-- переименовывать после создания — это переименование сломало бы историю
-- во всех уже сохранённых снапшотах и raw_metrics_json задним числом,
-- без возможности откатить. Разрешено менять только описательные поля.
CREATE TABLE IF NOT EXISTS attribute_definitions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK(data_type IN ('number','boolean','string')),
  unit TEXT,
  group_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_profile_attributes (
  profile_id TEXT NOT NULL REFERENCES equipment_profiles(id) ON DELETE CASCADE,
  attribute_key TEXT NOT NULL REFERENCES attribute_definitions(key),
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (profile_id, attribute_key)
);

-- Соответствие устройства shape (см. EQUIP_SHAPE_ORDER в public/index.html)
-- профилю по умолчанию — только для оборудования, у которого ещё не задан
-- собственный equipment.profileId в снапшоте. Ничего не ломает для старых
-- проектов: пока админ явно не выбрал профиль на объекте, это просто
-- формализует то, что оборудование этой формы и так уже отдаёт в мониторинг.
CREATE TABLE IF NOT EXISTS shape_default_profiles (
  shape TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES equipment_profiles(id)
);

CREATE TABLE IF NOT EXISTS cable_types (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  thickness REAL NOT NULL,
  line_type TEXT NOT NULL CHECK(line_type IN ('solid','dashed','dotted')),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Формы оборудования (см. EQUIP_SHAPE_LABELS/ORDER/DEFAULT_COLOR/
-- MONITORABLE_SHAPES в index.html — то же самое, что уже сделали с
-- cable_types). У 18 "родных" форм своя уникальная 3D-модель зашита в
-- buildEquipGeometry() (составная — из нескольких мешей) и имеет
-- приоритет; geometry ниже — это только fallback-примитив для формы,
-- заведённой исключительно через /references (полноценную bespoke-модель
-- без деплоя кода не завести, но хотя бы разные примитивы разной формы
-- лучше, чем всем одна и та же сфера). default_color может быть NULL —
-- тогда объект получает нейтральный дефолт 0x4fd6e0 (см. placeEquipment).
CREATE TABLE IF NOT EXISTS equipment_shapes (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  default_color TEXT,
  geometry TEXT NOT NULL DEFAULT 'sphere' CHECK(geometry IN ('sphere','box','cylinder','cone','capsule','disc')),
  monitorable INTEGER NOT NULL DEFAULT 0,
  selectable INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Системы связи/позиционирования в шахте (см. MONITOR_SYSTEMS/
-- CABLE_TYPE_SYSTEMS/EQUIP_SHAPE_SYSTEMS в index.html) — третий и
-- последний из справочников (после cable_types/equipment_shapes),
-- связывающий два предыдущих: какой тип кабеля/формы оборудования к какой
-- системе относится (кабель/оборудование может входить в несколько сразу,
-- см. таблицы связей ниже). key совпадает с отображаемым названием
-- (как и было в хардкоде — отдельного человекочитаемого label не
-- заводили, сущностей всего 5 и переименование задним числом настолько
-- же нежелательно, как для key кабеля/формы).
CREATE TABLE IF NOT EXISTS monitor_systems (
  key TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cable_type_systems (
  cable_type_key TEXT NOT NULL REFERENCES cable_types(key),
  system_key TEXT NOT NULL REFERENCES monitor_systems(key),
  PRIMARY KEY (cable_type_key, system_key)
);

CREATE TABLE IF NOT EXISTS equipment_shape_systems (
  shape_key TEXT NOT NULL REFERENCES equipment_shapes(key),
  system_key TEXT NOT NULL REFERENCES monitor_systems(key),
  PRIMARY KEY (shape_key, system_key)
);

-- Источники данных мониторинга на проект (см. /parsing — этот же конфиг
-- собирается и проверяется там как черновик, прежде чем стать реальным
-- источником здесь). В отличие от project_sppd_config (один захардкоженный
-- протокол на проект), тут произвольное число источников на проект и
-- произвольная логика разбора — см. custom-monitor-worker.js.
-- connection_json: { baseUrl, authType, username, password, endpoints:[{name,path}] }
-- parser_json: { mode: "bytype"|"bypoint", typePath, mtypes:[...], catalogRows:[...], groupConfigs:{...}, profiles:[...] }
--   — та же форма, что уже используется клиентским движком в public/parsing.html.
CREATE TABLE IF NOT EXISTS project_data_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  connection_json TEXT NOT NULL,
  parser_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_data_sources_project ON project_data_sources(project_id);
`);

// Одноразовый сид справочников — формализует то, что уже зашито в коде
// (CABLE_TYPES/EQUIP_SHAPE_* в public/index.html, ключи, которые воркеры уже
// пишут в raw_metrics_json) как редактируемые через UI данные, без изменения
// поведения для уже существующих проектов в день выкатки. Выполняется один
// раз — если строки уже есть (например, админ что-то удалил), сид не трогает
// таблицу повторно.
if (db.prepare("SELECT COUNT(*) AS n FROM attribute_definitions").get().n === 0) {
  const insertAttr = db.prepare(
    "INSERT INTO attribute_definitions (key, label, data_type, unit, group_name) VALUES (?, ?, ?, ?, ?)"
  );
  const seedAttrs = [
    ["online", "Статус: онлайн/офлайн", "boolean", null, "Общее"],
    ["firmware", "Версия прошивки", "string", null, "Общее"],
    ["rssi", "Уровень сигнала (RSSI)", "number", "дБ", "Сеть"],
    ["voltage", "Напряжение", "number", "В", "Электропитание"],
    ["batteryLvl", "Заряд батареи", "number", "%", "Электропитание"],
    ["personCount", "Счётчик людей", "number", "чел.", "Позиционирование"],
    ["vehicleCount", "Счётчик техники", "number", "ед.", "Позиционирование"],
    ["tagPulseEvent", "Событие: метка зарегистрирована", "boolean", null, "Позиционирование"],
    ["no2", "Концентрация NO₂", "number", "мг/м³", "Газоанализ"],
    ["so2", "Концентрация SO₂", "number", "мг/м³", "Газоанализ"],
    ["co", "Концентрация CO", "number", "мг/м³", "Газоанализ"],
    ["co2", "Концентрация CO₂", "number", "%", "Газоанализ"],
    ["temperature", "Температура", "number", "°C", "Газоанализ"],
  ];
  for (const row of seedAttrs) insertAttr.run(...row);

  const insertProfile = db.prepare("INSERT INTO equipment_profiles (id, name) VALUES (?, ?)");
  const insertProfileAttr = db.prepare(
    "INSERT INTO equipment_profile_attributes (profile_id, attribute_key, sort_order) VALUES (?, ?, ?)"
  );
  const seedProfiles = [
    ["p-isib", "ISIB", ["online", "rssi", "voltage"]],
    ["p-iilb", "IILB", ["online", "personCount", "vehicleCount", "rssi"]],
    ["p-ags", "Газоанализатор АГС", ["no2", "so2", "co", "co2", "temperature"]],
    ["p-beacon", "Маяк / сирена", ["online", "firmware"]],
  ];
  for (const [id, name, attrs] of seedProfiles) {
    insertProfile.run(id, name);
    attrs.forEach((key, i) => insertProfileAttr.run(id, key, i));
  }

  const insertShapeDefault = db.prepare(
    "INSERT INTO shape_default_profiles (shape, profile_id) VALUES (?, ?)"
  );
  insertShapeDefault.run("isib", "p-isib");
  insertShapeDefault.run("iilb", "p-iilb");
}

if (db.prepare("SELECT COUNT(*) AS n FROM cable_types").get().n === 0) {
  const insertCableType = db.prepare(
    "INSERT INTO cable_types (key, label, color, thickness, line_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const seedCableTypes = [
    ["vols", "ВОЛС", "#ffcc00", 14, "solid"],
    ["lfc", "LFC", "#2ecc71", 11, "solid"],
    ["kao", "КАО", "#29b6f6", 8, "dashed"],
    ["tk", "ТК", "#1abc9c", 6, "solid"],
    ["power", "Силовой", "#e74c3c", 5, "solid"],
    ["ftp", "FTP", "#9b59b6", 3, "dotted"],
  ];
  seedCableTypes.forEach((row, i) => insertCableType.run(...row, i));
}

if (db.prepare("SELECT COUNT(*) AS n FROM equipment_shapes").get().n === 0) {
  const insertShape = db.prepare(
    "INSERT INTO equipment_shapes (key, label, default_color, geometry, monitorable, selectable, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  // [key, label, default_color|null, geometry, monitorable, selectable] —
  // 1:1 то, что сейчас зашито в index.html (EQUIP_SHAPE_*), включая
  // устаревший "stativ" (selectable=0 — не предлагается при создании новой
  // единицы, только для группировки уже расставленных до разделения на
  // LFC/АО). geometry тут просто приблизительный fallback-примитив — у
  // всех этих 18 форм есть своя bespoke-модель в buildEquipGeometry(),
  // которая имеет приоритет, это поле никогда для них не используется.
  const seedShapes = [
    ["mla", "MLA", "#4fd6e0", "box", 0, 1],
    ["map", "MAP", "#2ecc71", "box", 1, 1],
    ["odf", "Муфта ODF", "#f1c40f", "cylinder", 0, 1],
    ["iilb", "IILB", "#3498db", "box", 1, 1],
    ["isib", "ISIB", "#9b59b6", "box", 1, 1],
    ["cam", "CAM", "#455a64", "box", 1, 1],
    ["mps", "MPS", "#e67e22", "cylinder", 0, 1],
    ["mpc", "MPC", "#e67e22", "box", 0, 1],
    ["mtu", "MTU", "#e67e22", "box", 0, 1],
    ["mvsa", "MVSA", "#e67e22", "cone", 0, 1],
    ["wifi", "WiFi", "#1abc9c", "disc", 1, 1],
    ["mbu", "MBU", "#95a5a6", "box", 0, 1],
    ["fs", "FS", "#e74c3c", "box", 1, 1],
    ["tel", "TEL", "#3498db", "box", 1, 1],
    ["stativ_lfc", "Статив LFC", "#2ecc71", "box", 1, 1],
    ["stativ_ao", "Статив АО", "#9b59b6", "box", 1, 1],
    ["poe", "PoE", "#f39c12", "box", 0, 1],
    ["go", "ГО", "#e74c3c", "cone", 1, 1],
    ["stativ", "Статив (устар.)", null, "box", 0, 0],
    ["custom", "Другое", null, "sphere", 1, 1],
  ];
  seedShapes.forEach((row, i) => insertShape.run(...row, i));
}

if (db.prepare("SELECT COUNT(*) AS n FROM monitor_systems").get().n === 0) {
  const insertSystem = db.prepare("INSERT INTO monitor_systems (key, sort_order) VALUES (?, ?)");
  ["ВОЛС", "LFC", "АО", "Телефония", "ВН"].forEach((key, i) => insertSystem.run(key, i));

  const insertCableTypeSystem = db.prepare(
    "INSERT INTO cable_type_systems (cable_type_key, system_key) VALUES (?, ?)"
  );
  // 1:1 с CABLE_TYPE_SYSTEMS в index.html — силовой кабель общий для всех систем.
  const cableTypeSystems = {
    vols: ["ВОЛС"],
    lfc: ["LFC"],
    kao: ["АО"],
    tk: ["Телефония"],
    ftp: ["ВН"],
    power: ["ВОЛС", "LFC", "АО", "Телефония", "ВН"],
  };
  for (const [cableType, systems] of Object.entries(cableTypeSystems)) {
    for (const system of systems) insertCableTypeSystem.run(cableType, system);
  }

  const insertShapeSystem = db.prepare(
    "INSERT INTO equipment_shape_systems (shape_key, system_key) VALUES (?, ?)"
  );
  // 1:1 с EQUIP_SHAPE_SYSTEMS в index.html — "custom" туда никогда не входил
  // (оборудование произвольной формы не попадает ни в один системный фильтр).
  const shapeSystems = {
    map: ["ВОЛС", "Телефония", "ВН"],
    odf: ["ВОЛС"],
    wifi: ["ВОЛС"],
    mla: ["LFC"], iilb: ["LFC"], isib: ["LFC"], mps: ["LFC"], mpc: ["LFC"],
    mtu: ["LFC"], mvsa: ["LFC"], mbu: ["LFC"],
    stativ_lfc: ["LFC"],
    stativ_ao: ["АО"],
    stativ: ["LFC", "АО"],
    fs: ["АО"],
    go: ["АО"],
    tel: ["Телефония"],
    cam: ["ВН"],
    poe: ["ВН"],
  };
  for (const [shape, systems] of Object.entries(shapeSystems)) {
    for (const system of systems) insertShapeSystem.run(shape, system);
  }
}

// Добавочная миграция: geometry на equipment_shapes — появилась позже
// основного сида выше (см. обсуждение выбора 3D-модели формы), поэтому не
// может просто попасть в CREATE TABLE/seed: на уже задеплоенной инсталляции
// таблица создана и засеяна раньше этой колонки.
{
  const hasGeometryColumn = db.prepare("PRAGMA table_info(equipment_shapes)").all().some((c) => c.name === "geometry");
  if (!hasGeometryColumn) {
    db.exec("ALTER TABLE equipment_shapes ADD COLUMN geometry TEXT NOT NULL DEFAULT 'sphere'");
  }
}

// Добавочная миграция: поля подключения офсайт-целей автобэкапа на
// backup_settings — появились позже основного CREATE TABLE (переход с
// файлов/env на полностью UI-based настройку, см. server/routes/backup.js
// /gdrive/connect и /ssh/save), поэтому не могут просто попасть в CREATE
// TABLE: на уже задеплоенной инсталляции таблица создана раньше этих
// колонок. gdrive_client_secret и ssh_private_key — единственные
// настоящие секреты здесь; и то, и другое явно одобрено пользователем
// как исключение из общего принципа "секреты только в .env/файлах" ради
// простоты настройки через UI.
{
  const bkCols = db.prepare("PRAGMA table_info(backup_settings)").all().map((c) => c.name);
  const addBkCol = (name, decl) => {
    if (!bkCols.includes(name)) db.exec(`ALTER TABLE backup_settings ADD COLUMN ${name} ${decl || "TEXT"}`);
  };
  addBkCol("gdrive_client_id");
  addBkCol("gdrive_client_secret");
  addBkCol("gdrive_refresh_token");
  addBkCol("gdrive_folder_id");
  addBkCol("ssh_host");
  addBkCol("ssh_user");
  // INTEGER, не TEXT — иначе SQLite type affinity хранит число как
  // "2222.0" (better-sqlite3 биндит обычный JS number как REAL, TEXT
  // affinity конвертирует REAL в текст с дробной частью).
  addBkCol("ssh_port", "INTEGER");
  addBkCol("ssh_remote_dir");
  addBkCol("ssh_private_key");
}

// Добавочная миграция: rx/tx (счётчики принятых/переданных пакетов
// считывателя) — появились позже основного сида выше (см. настройку
// кастомных источников для IILB/ISIB через /parsing), поэтому не могут
// просто попасть в seedAttrs: тот блок сидирует только один раз при
// пустой таблице, а на существующих инсталляциях она уже не пуста.
// INSERT OR IGNORE — на случай если админ уже сам завёл ключ с таким же
// именем через UI.
{
  const insertAttrIfMissing = db.prepare(
    "INSERT OR IGNORE INTO attribute_definitions (key, label, data_type, unit, group_name) VALUES (?, ?, ?, ?, ?)"
  );
  insertAttrIfMissing.run("rx", "Rx (принято пакетов)", "number", null, "Сеть");
  insertAttrIfMissing.run("tx", "Tx (передано пакетов)", "number", null, "Сеть");
}

// Добавочная миграция: SLA-сроки тикетов по приоритету (часы на устранение)
// — те же 4 столбца, что и остальные пороги, поэтому просто ADD COLUMN,
// без пересоздания таблицы (см. миграцию ping_fail_threshold выше).
{
  const cols = db.prepare("PRAGMA table_info(project_monitor_thresholds)").all();
  const slaDefaults = {
    ticket_sla_critical_hours: 2,
    ticket_sla_high_hours: 8,
    ticket_sla_medium_hours: 24,
    ticket_sla_low_hours: 72,
    // Пороги для custom-monitor-worker.js (project_data_sources) — та же
    // логика stale-after/fail-duration, что у ping_* выше, но отдельные
    // колонки: источники через конструктор парсера могут быть чем угодно,
    // разный протокол на источник.
    custom_stale_after_sec: 120,
    custom_fail_duration_sec: 300,
  };
  for (const [col, def] of Object.entries(slaDefaults)) {
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE project_monitor_thresholds ADD COLUMN ${col} INTEGER NOT NULL DEFAULT ${def}`);
    }
  }
}

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
      lamp_fail_after_hours INTEGER NOT NULL DEFAULT 24,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} else {
  // Чисто добавочные миграции (в отличие от переименования выше) — здесь
  // уже могли быть настоящие сохранённые пороги, поэтому ADD COLUMN с
  // дефолтом, а не пересоздание таблицы.
  if (!monitorThresholdsCols.some((c) => c.name === "lamp_fail_after_hours")) {
    db.exec("ALTER TABLE project_monitor_thresholds ADD COLUMN lamp_fail_after_hours INTEGER NOT NULL DEFAULT 24");
  }
}

// Одноразовая миграция: добавление роли supervisor + переименование editor
// в engineer. SQLite не даёт менять CHECK-constraint через ALTER TABLE,
// поэтому пересоздаём таблицу — но только если она ещё не в новом виде
// (проверяем по тексту CHECK в sqlite_master, а не гадаем по данным: строк
// с ролью 'editor' может и не быть, если админ ещё не заводил ни одного
// такого пользователя, но таблицу всё равно нужно пересоздать под новый
// CHECK, иначе INSERT нового supervisor/engineer упадёт).
{
  const usersTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (usersTableSql && !usersTableSql.sql.includes("'engineer'")) {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('viewer','engineer','supervisor','admin')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, username, password_hash, role, created_at)
        SELECT id, username, password_hash, CASE WHEN role = 'editor' THEN 'engineer' ELSE role END, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  }
}

// Бэкап-модуль (server/backup/run-backup.js) снимает копию по этому же пути —
// проще прицепить его к уже открытому db, чем пересчитывать DB_PATH заново
// в другом файле и рисковать разойтись, если дефолт когда-нибудь поменяется.
db.DB_PATH = DB_PATH;
module.exports = db;
