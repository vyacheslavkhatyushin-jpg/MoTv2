/*
Универсальный парсер отчёта "Текущие местоположение" (SPPD/SBeacon) — формат
файла и набор/порядок колонок отличаются между проектами (шахтами): apk отдаёт
.xlsx с одним полем ФИО и меткой "Не задан / <id>" вместо номера фонаря
(фонарь = личный тег), ipk/opk отдают старый бинарный .xls, где ФИО разбито на
Фамилия/Имя/Отчество и есть отдельный реальный номер фонаря "Св.№".

Вместо фиксированных индексов колонок ищем строку заголовков по ключевым
словам и сопоставляем каждую колонку по тексту, а не по позиции — так один и
тот же код разбирает оба формата (и любой третий с тем же набором понятий).
*/
const XLSX = require("xlsx");

const HEADER_ALIASES = {
  tabNumber: ["таб.№/id", "таб.№", "таб №"],
  fio: ["фио/название", "фио"],
  lastName: ["фамилия"],
  firstName: ["имя/название", "имя"],
  middleName: ["отчество"],
  position: ["должность"],
  department: ["подразделение"],
  organization: ["организация"],
  lampNumber: ["зав.№/свет.№", "зав.№", "св.№", "свет.№"],
  tagCombined: ["таг 433/таг 24"],
  tag433: ["таг 433"],
  tag24: ["таг 24"],
  reader: ["считыватель", "зона"],
  lastSeenAt: ["время посл. рег.", "время посл.рег."],
};

function normalizeHeader(text) {
  return String(text ?? "").trim().toLowerCase();
}

function matchColumn(headerText) {
  const norm = normalizeHeader(headerText);
  if (!norm) return null;
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(norm)) return field;
  }
  return null;
}

function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cols = {};
    for (let c = 0; c < rows[i].length; c++) {
      const field = matchColumn(rows[i][c]);
      if (field) cols[field] = c;
    }
    // Достаточный якорь: таб.№ + любое поле имени — остальные колонки не у
    // всех форматов совпадают дословно, но эти два есть везде.
    if (cols.tabNumber !== undefined && (cols.fio !== undefined || cols.lastName !== undefined)) {
      return { rowIndex: i, cols };
    }
  }
  return null;
}

// "Отчёт создан 16.09.26 15:32:06" / "Дата создания: 16.09.2026 14:52:24" —
// не завязываемся на подпись, ищем сам паттерн даты+времени.
const DATE_RE = /(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})/;
function findReportDate(rows, maxScan = 12) {
  for (let i = 0; i < Math.min(maxScan, rows.length); i++) {
    for (const cell of rows[i]) {
      const m = DATE_RE.exec(String(cell ?? ""));
      if (m) {
        let [, dd, mm, yy, hh, mi, ss] = m;
        const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10);
        return new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10), parseInt(hh, 10), parseInt(mi, 10), parseInt(ss, 10));
      }
    }
  }
  return null;
}

function excelDateToJs(value) {
  // xlsx может вернуть дату-время как готовую строку "16.09.2026 15:30:23"
  // ИЛИ как число (серийная дата Excel) в зависимости от формата ячейки —
  // оба варианта встречаются на живых файлах.
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, Math.round(parsed.S || 0));
  }
  const m = DATE_RE.exec(String(value ?? ""));
  if (!m) return null;
  let [, dd, mm, yy, hh, mi, ss] = m;
  const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10);
  return new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10), parseInt(hh, 10), parseInt(mi, 10), parseInt(ss, 10));
}

function cellText(v) {
  return String(v ?? "").trim();
}

// "Не задан / 29949" -> нет отдельного номера фонаря, идентификатор = таб.№/тег.
// Голое число (или строка-число) -> реальный отдельный номер фонаря.
function resolveLampId(rawLampNumber, tabNumber, tagCombined, tag433, tag24) {
  const raw = cellText(rawLampNumber);
  if (raw && !/^не задан/i.test(raw)) {
    const numMatch = /(\d+)\s*$/.exec(raw);
    return numMatch ? numMatch[1] : raw;
  }
  const tag = cellText(tagCombined) || cellText(tag433) || cellText(tag24);
  if (tag && tag !== "-") {
    const first = tag.split("/")[0].trim();
    if (first) return first;
  }
  return cellText(tabNumber);
}

// Некоторые экспортёры (подтверждено на живом отчёте apk) пишут в xlsx
// заведомо неверный <dimension> — например "A1:I7" при реальных ~1000
// строках. SheetJS доверяет этому диапазону и молча обрезает sheet_to_json
// по нему, а не по факту заполненных ячеек — пересчитываем !ref из
// реальных ключей листа перед чтением, иначе часть отчёта тихо потеряется.
function fixSheetRange(sheet) {
  let maxRow = 0;
  let maxCol = 0;
  for (const key of Object.keys(sheet)) {
    if (key[0] === "!") continue;
    const addr = XLSX.utils.decode_cell(key);
    if (addr.r > maxRow) maxRow = addr.r;
    if (addr.c > maxCol) maxCol = addr.c;
  }
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
}

function parseLampReport(buffer, filename) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  fixSheetRange(sheet);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

  const reportGeneratedAt = findReportDate(rows);
  const header = findHeaderRow(rows);
  if (!header) {
    throw new Error("Не удалось найти строку заголовков в отчёте (ожидались колонки «Таб.№» и «ФИО»/«Фамилия»)");
  }
  if (!reportGeneratedAt) {
    throw new Error("Не удалось найти дату формирования отчёта в первых строках файла");
  }

  const { cols } = header;
  const records = [];
  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const get = (field) => (cols[field] !== undefined ? row[cols[field]] : "");

    const tabNumber = cellText(get("tabNumber"));
    let fullName;
    if (cols.fio !== undefined) {
      fullName = cellText(get("fio"));
    } else {
      fullName = [cellText(get("lastName")), cellText(get("firstName")), cellText(get("middleName"))]
        .filter(Boolean)
        .join(" ");
    }
    if (!tabNumber || !fullName) continue; // пустые/служебные строки-дубли — пропускаем

    const lastSeenRaw = get("lastSeenAt");
    const lastSeenAt = excelDateToJs(lastSeenRaw);
    if (!lastSeenAt) continue;

    records.push({
      tabNumber,
      fullName,
      position: cellText(get("position")),
      department: cellText(get("department")),
      organization: cellText(get("organization")),
      lampId: resolveLampId(get("lampNumber"), tabNumber, get("tagCombined"), get("tag433"), get("tag24")),
      reader: cellText(get("reader")),
      lastSeenAt,
    });
  }

  return { reportGeneratedAt, records, sourceFilename: filename };
}

module.exports = { parseLampReport, matchColumn, findHeaderRow, findReportDate, resolveLampId };
