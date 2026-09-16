const crypto = require('crypto');
const config = require('../config');

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', config.admin.sessionSecret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession() {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub: 'admin', iat: now, exp: now + config.admin.sessionHours * 3600 }));
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!safeEqual(sign(payload), signature)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.sub === 'admin' && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function verifyPassword(password) {
  return Boolean(config.admin.password) && safeEqual(config.admin.password, password);
}

module.exports = { createSession, verifySession, verifyPassword };
