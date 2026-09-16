const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../auth");
const { logAudit } = require("../lib/audit");

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "missing_credentials" });
  }
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logAudit({ actor: username, action: "login.failed", ip: req.ip });
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const token = signToken(user);
  logAudit({ actor: user.username, action: "login.success", ip: req.ip });
  res.json({ token, username: user.username, role: user.role });
});

module.exports = router;
