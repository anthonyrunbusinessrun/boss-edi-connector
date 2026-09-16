const config = require('../config');
const { verifySession } = require('../services/session');

function bearer(req) {
  const value = req.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function requireAdmin(req, res, next) {
  if (!verifySession(bearer(req))) {
    return res.status(401).json({ success: false, error: 'Authentication required', requestId: req.requestId });
  }
  next();
}

function clientIp(req) {
  return String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function requireInboundAuth(req, res, next) {
  if (!config.inbound.token) {
    return res.status(503).json({ success: false, error: 'Inbound EDI authentication is not configured', requestId: req.requestId });
  }
  const supplied = req.get(config.inbound.tokenHeader) || (config.inbound.tokenHeader === 'authorization' ? bearer(req) : '');
  if (supplied !== config.inbound.token && supplied !== `Bearer ${config.inbound.token}`) {
    return res.status(401).json({ success: false, error: 'Invalid inbound EDI credentials', requestId: req.requestId });
  }
  if (config.inbound.allowedIps.length && !config.inbound.allowedIps.includes(clientIp(req))) {
    return res.status(403).json({ success: false, error: 'Source IP is not allowed', requestId: req.requestId });
  }
  next();
}

module.exports = { requireAdmin, requireInboundAuth };
