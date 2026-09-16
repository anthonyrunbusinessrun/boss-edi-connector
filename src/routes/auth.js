const express = require('express');
const config = require('../config');
const { createSession, verifyPassword } = require('../services/session');

const router = express.Router();
const attempts = new Map();

function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
  recent.push(now);
  attempts.set(key, recent);
  next();
}

router.post('/login', rateLimit, (req, res) => {
  if (!config.admin.password) return res.status(503).json({ success: false, error: 'Administrator login is not configured' });
  if (!verifyPassword(req.body?.password || '')) return res.status(401).json({ success: false, error: 'Invalid password' });
  attempts.delete(req.ip || 'unknown');
  res.json({ success: true, accessToken: createSession(), expiresIn: config.admin.sessionHours * 3600 });
});

module.exports = router;
