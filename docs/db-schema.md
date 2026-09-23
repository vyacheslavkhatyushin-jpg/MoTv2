# Схема БД

SQLite (`server/db.js`, WAL mode). Полная схема — там же, одним `db.exec(...)`
+ добавочные миграции ниже него (`ALTER TABLE`/пересоздание при смене
CHECK-constraint). Этот файл — карта по группам таблиц и связям между ними,
не замена чтения db.js — при реальных вопросах "какие колонки/дефолты" смотри
туда, там комментарии почему, а не только что.

## Ядро: пользователи и проекты

| Таблица | Что хранит | Связи |
|---|---|---|
| `users` | Логин/bcrypt-хэш/роль (`viewer < engineer < supervisor < admin`) | — |
| `projects` | Список проектов (шахт), `id` — человекочитаемый slug (не автоинкремент) | родитель почти всего ниже, `ON DELETE CASCADE` |
| `project_state` | **Вся 3D-модель проекта одной строкой** — `snapshot_json` = `{cables, equipment, marks, patches}`, плюс `version` (оптимистичная блокировка при сохранении) | 1:1 с `projects` |
| `deletion_log` | Append-only: кто/когда удалил объект модели (кабель/оборудование/метку/заплатку) — пишется сразу при удалении, не ждёт "Сохранить" | → `projects` |

**Важно**: кабели/оборудование/метки/заплатки — это **не строки таблиц**, а
элементы массивов внутри `project_state.snapshot_json`. У SQL-таблиц ниже
(`monitor_status`, `tickets` и т.п.) `equipment_id` — это просто `id` объекта
внутри JSON, **без FK** (SQLite не умеет ссылаться внутрь JSON-колонки) —
поэтому оборудование можно удалить/переименовать (сменить id), а старые
строки в этих таблицах не подчистятся сами. Это и есть корень бага "подвисшие
данные" из истории проекта — фикс на стороне чтения, см.
`server/lib/monitorShared.js` → `getMonitoredEquipmentIds`.

## Мониторинг

| Таблица | Что хранит | Особенность |
|---|---|---|
| `monitor_status` | Текущее состояние КАЖДОГО отслеживаемого объекта — кэш, перезаписывается на каждый опрос (`up`/`down`/`degraded`/`unknown`) | PK `(project_id, equipment_id)`; источник правды для подсветки на 3D-модели и статус-бара |
| `monitor_events` | Append-only история аварий (не каждый флап — только простой дольше `fail_duration_sec`) | → `projects`; `tickets.monitor_event_id` может на неё ссылаться |
| `monitor_tag_pulses` | Эфемерная очередь "метка зарегистрирована на считывателе" — живёт секунды, для разовой вспышки в 3D | → `projects` |
| `project_monitor_thresholds` | Пороги аварии **на проект** (ping timeout, fail-duration, SLA тикетов по приоритету, пороги для custom-источников) | 1:1 с `projects`; нет строки = дефолты из env воркеров |
| `project_shape_thresholds` | То же, но override **на (проект, форма оборудования)** — например, другой fail-duration для газоанализатора | PK `(project_id, shape)`; NULL-колонка = "бери дефолт проекта" |
| `project_data_sources` | Настраиваемые источники данных мониторинга (произвольный протокол/парсер, см. `/parsing`) | → `projects`; `connection_json`/`parser_json` |

Кто пишет в `monitor_status`/`monitor_events`: `server/monitor/ping-worker.js`
(ping) и `server/monitor/custom-monitor-worker.js` (все настраиваемые
источники) — оба отдельные процессы, не часть основного `server.js`.

## ЗИП (склад запчастей)

| Таблица | Что хранит | Особенность |
|---|---|---|
| `zip_items` | Справочник позиций склада, `qty_on_hand`/`qty_reserved` — **кэш**, не источник правды | → `projects` |
| `zip_requests` | Заявка инженера на выдачу: `pending → approved (резерв) → issued (списание)` / `rejected`/`cancelled` | → `zip_items` |
| `zip_movements` | **Источник правды** по остаткам — append-only лог (`receipt`/`issue`/`adjustment`) | → `zip_items`, опц. → `zip_requests` |

## Фонари (SPPD-отчёты)

| Таблица | Что хранит |
|---|---|
| `lamp_reports` | Одна строка на загруженный .xls/.xlsx отчёт — агрегаты (всего/исправно/неисправно) |
| `lamp_records` | Построчная разбивка отчёта (табельный №, ФИО, ID лампы, `is_broken`) — `is_broken` считается один раз при загрузке, не задним числом |

`lamp_records.report_id → lamp_reports.id ON DELETE CASCADE`.

## Тикеты (устранение аварий/находок)

| Таблица | Что хранит |
|---|---|
| `tickets` | Заявка на устранение — опционально привязана к оборудованию/аварии (`equipment_id` без FK, `monitor_event_id → monitor_events`) |
| `ticket_comments` | Комментарии к тикету |
| `ticket_attachments` | Фото — **BLOB прямо в SQLite** (не на диске), чтобы попадали в тот же бэкап без отдельного volume |

`ticket_comments`/`ticket_attachments.ticket_id → tickets.id ON DELETE CASCADE`.

## Справочники (общие на всю систему, не per-project)

Формализация того, что раньше было зашито в код (`public/index.html`).
**`key` нельзя переименовывать** после создания — используется как
литеральное значение внутри `project_state.snapshot_json`/`raw_metrics_json`
во всех уже сохранённых проектах; переименование тихо сломало бы историю.

| Таблица | Что хранит |
|---|---|
| `cable_types` | Типы кабеля (цвет/толщина/стиль линии на 3D-модели) |
| `equipment_shapes` | Формы оборудования (цвет/fallback-геометрия/мониторится ли) |
| `monitor_systems` | Системы связи (ВОЛС, LFC, АО, Телефония, ВН) |
| `cable_type_systems`, `equipment_shape_systems` | Связки many-to-many: какой тип/форма к какой системе относится |
| `attribute_definitions` | Метрики мониторинга (voltage, rssi, personCount, no2…) — тип/единица/группа |
| `equipment_profiles`, `equipment_profile_attributes` | Наборы метрик под конкретную форму оборудования (напр. профиль "IILB" = online+personCount+vehicleCount+rssi) |
| `shape_default_profiles` | Форма → профиль по умолчанию, если на объекте профиль не выбран явно |

## Аудит и общесистемные настройки

| Таблица | Что хранит |
|---|---|
| `audit_log` | Единый журнал действий (вход, правки, удаления, управление пользователями/бэкапом/сетью…). `project_id` — `ON DELETE SET NULL`, запись переживает удаление проекта |
| `server_settings` | Singleton-строка (`id=1`) — сейчас только исходящий HTTP(S)-прокси (Настройки → Сеть); .env — фолбэк, если тут пусто |
| `backup_settings` | Singleton-строка — конфиг автобэкапа БД, включая SSH-ключ и Google Drive OAuth-токен целиком в БД (осознанное исключение из "секреты только в .env", одобрено пользователем ради простоты UI) |
| `backup_runs` | История прогонов автобэкапа (статус/размер/ошибка) |

## Паттерны, которые повторяются

- **Append-only лог рядом с кэшем состояния**: `monitor_status` (кэш) +
  `monitor_events` (лог), `zip_items.qty_*` (кэш) + `zip_movements` (лог),
  `project_state` (текущее) + `deletion_log` (лог). Кэш можно пересчитать из
  лога, лог из кэша — никогда.
- **`ON DELETE CASCADE` от `projects`** почти everywhere — удалил проект,
  всё связанное ушло с ним (кроме `audit_log`, у него `SET NULL`).
- **Singleton-таблица** (`id INTEGER PRIMARY KEY CHECK (id = 1)`) для
  общесерверных настроек без владельца-проекта (`server_settings`,
  `backup_settings`) — одна строка, `INSERT OR IGNORE` при старте.
- **`equipment_id`/`cableType`/`shape` — строки, не FK** в любую сторону:
  либо это id объекта внутри JSON-снапшота (без FK в принципе), либо ключ
  справочника (FK есть, но на `TEXT PRIMARY KEY`, не на числовой id).
