/*
Настройки → Сеть (admin) — общесерверные сетевые настройки, сейчас
единственная: исходящий HTTP(S)-прокси (см. server/lib/proxy.js). Не
per-project, как Пользователи/Резервное копирование. Значение из этого
раздела всегда перекрывает HTTPS_PROXY/HTTP_PROXY из docker-compose.yml —
на разных площадках прокси разный или его вовсе нет, и это должно
меняться без пересборки контейнера.
*/
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { logAudit } = require("../lib/audit");
const { applyProxy, getConfiguredProxyUrl } = require("../lib/proxy");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function getSettings() {
  return db.prepare("SELECT * FROM server_settings WHERE id = 1").get();
}

router.get("/settings", (req, res) => {
  const row = getSettings();
  res.json({
    outboundProxyUrl: row.outbound_proxy_url || "",
    effectiveProxyUrl: getConfiguredProxyUrl(),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
});

const PROXY_URL_RE = /^https?:\/\/\S+$/i;

router.put("/settings", (req, res) => {
  const { outboundProxyUrl } = req.body || {};
  if (typeof outboundProxyUrl !== "string") return res.status(400).json({ error: "invalid_outbound_proxy_url" });
  const trimmed = outboundProxyUrl.trim();
  if (trimmed && !PROXY_URL_RE.test(trimmed)) return res.status(400).json({ error: "invalid_outbound_proxy_url" });

  db.prepare(
    "UPDATE server_settings SET outbound_proxy_url = ?, updated_by = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(trimmed || null, req.user.username);

  applyProxy(getConfiguredProxyUrl());
  logAudit({ actor: req.user.username, action: "network.settings.update", entityType: "server_settings", ip: req.ip });

  const row = getSettings();
  res.json({
    outboundProxyUrl: row.outbound_proxy_url || "",
    effectiveProxyUrl: getConfiguredProxyUrl(),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
});

module.exports = router;
