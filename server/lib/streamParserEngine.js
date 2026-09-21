/*
Общий движок разбора сообщений для настраиваемых источников данных
(project_data_sources, см. db.js) — логика 1-в-1 повторяет то, что уже
проверено интерактивно в public/parsing.html (resolvePath/applyTransform/
разбор по типу сообщения/разбор потока точек через каталог+профиль), только
на Node, чтобы её мог использовать custom-monitor-worker.js. Сознательно не
переиспользуется как общий модуль с браузером — в проекте нет сборки под
общий код клиент/сервер, а логика достаточно компактна, чтобы дублирование
было дешевле, чем городить бандлер ради одного файла.

parserConfig (parser_json колонки project_data_sources):
  {
    mode: "bytype" | "bypoint",
    typePath: "$.WSM_TYPE",                    // для "bytype"
    mtypes: [{ match, addressPath, fields:[{source, target, transform, tval, customName}] }],
    catalogRows: [{ id, idjs, typedata, option, groupKey }],  // для "bypoint"
    groupConfigs: { "<idjs>": { mode:"direct"|"profile", addressRegex, profileId } },
    profiles: [{ id, name, channels:[{td, target, customName, unit, transform, tval}] }],
  }

Результат разбора одного сообщения — массив { address, key, value } — key это
либо сам target (совпадает с key в attribute_definitions, см. references.js),
либо customName для "своих" метрик.
*/

function resolvePath(obj, path) {
  if (!path) return undefined;
  const parts = String(path).replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function applyTransform(raw, transform, tval) {
  if (raw === undefined) return undefined;
  switch (transform) {
    case "boolean":
      return Boolean(raw);
    case "equals":
      return String(raw) === String(tval);
    case "multiply": {
      const factor = parseFloat(tval);
      return typeof raw === "number" && !Number.isNaN(factor) ? Math.round(raw * factor * 100) / 100 : raw;
    }
    case "round2":
      return typeof raw === "number" ? Math.round(raw * 100) / 100 : raw;
    default:
      return raw;
  }
}

function fieldKey(field) {
  return field.target === "custom" ? field.customName : field.target;
}

/* ---------- режим "по типу сообщения" (SPPD/akvs_sys_monitor и т.п.) ---------- */
function parseByType(rawMessage, parserConfig) {
  let msg;
  try {
    msg = JSON.parse(rawMessage);
  } catch (e) {
    return null;
  }
  if (typeof msg.WSM_DATA === "string") {
    try {
      msg.WSM_DATA = JSON.parse(msg.WSM_DATA);
    } catch (e) {
      // не JSON-строка — оставляем как есть
    }
  }
  let typeVal = resolvePath(msg, parserConfig.typePath || "$.WSM_TYPE");
  if (typeof typeVal === "string") typeVal = typeVal.trim();

  const mt = (parserConfig.mtypes || []).find((m) => m.match === typeVal);
  if (!mt) return null;

  const address = resolvePath(msg.WSM_DATA, mt.addressPath);
  if (address === undefined || address === null) return null;

  const attributes = [];
  for (const field of mt.fields || []) {
    const raw = resolvePath(msg.WSM_DATA, field.source);
    const value = applyTransform(raw, field.transform, field.tval);
    if (value === undefined) continue;
    attributes.push({ key: fieldKey(field), value });
  }
  return { address: String(address), attributes };
}

/* ---------- режим "поток точек через каталог" (газоанализаторы, сирены и т.п.) ---------- */
function resolveCatalogRow(parserConfig, id) {
  return (parserConfig.catalogRows || []).find((r) => String(r.id) === String(id));
}

function parseByPoint(rawMessage, parserConfig) {
  let msg;
  try {
    msg = JSON.parse(rawMessage);
  } catch (e) {
    return [];
  }
  const results = [];
  for (const item of msg.data || []) {
    const row = resolveCatalogRow(parserConfig, item.id);
    if (!row) continue;
    const cfg = (parserConfig.groupConfigs || {})[row.idjs] || { mode: "direct" };

    if (cfg.mode === "direct") {
      const address = row.option && row.option.addr ? row.option.addr : row.groupKey;
      const key = row.option && row.option.type ? row.option.type : "raw";
      results.push({ address: String(address), attributes: [{ key, value: item.v }] });
      continue;
    }

    const profile = (parserConfig.profiles || []).find((p) => p.id === cfg.profileId);
    const channel = profile ? profile.channels.find((c) => c.td === row.typedata) : null;
    if (!channel) continue;
    let address = row.groupKey;
    try {
      const m = new RegExp(cfg.addressRegex).exec(row.groupKey);
      if (m) address = m[1];
    } catch (e) {
      // некорректный regex в конфиге — используем groupKey как есть
    }
    const value = applyTransform(item.v, channel.transform, channel.tval);
    if (value === undefined) continue;
    results.push({ address: String(address), attributes: [{ key: fieldKey(channel), value }] });
  }
  return results;
}

/*
Единая точка входа для воркера: возвращает массив { address, attributes }
независимо от режима — parseByType даёт максимум одну запись на сообщение
(один WSM_DATA = одно устройство), parseByPoint может дать несколько
(один kадр потока точек — массив показаний).
*/
function parseMessage(rawMessage, parserConfig) {
  if (parserConfig.mode === "bypoint") return parseByPoint(rawMessage, parserConfig);
  const single = parseByType(rawMessage, parserConfig);
  return single ? [single] : [];
}

module.exports = { resolvePath, applyTransform, parseByType, parseByPoint, parseMessage };
