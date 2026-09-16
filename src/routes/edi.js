const express = require('express');
const config = require('../config');
const db = require('../db');
const { requireInboundAuth } = require('../middleware/auth');
const { processInbound850, recordRejected, X12Error } = require('../services/inbound');

const router = express.Router();

router.get('/health', async (req, res) => {
  let database = 'ok';
  try { await db.query('SELECT 1'); } catch { database = 'unavailable'; }
  const issues = config.readinessIssues();
  const ready = database === 'ok' && issues.length === 0;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'configuration_required',
    service: 'Ray Land BusinessOS EDI Gateway',
    version: '2.1.0',
    database,
    outboundMode: config.outbound.mode,
    edi856Enabled: config.edi.enable856,
    issues,
    timestamp: new Date().toISOString(),
  });
});

router.post(
  '/inbound',
  requireInboundAuth,
  express.text({ type: ['text/plain', 'application/edi-x12', 'application/octet-stream', 'application/*'], limit: config.inbound.maxBytes }),
  async (req, res, next) => {
    const meta = {
      filename: String(req.get('x-filename') || `inbound_${Date.now()}.edi`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255),
      correlationId: String(req.get('x-correlation-id') || req.requestId).slice(0, 100),
      partner: String(req.get('x-edi-partner') || '').slice(0, 100) || null,
    };
    try {
      const result = await processInbound850(req.body, meta);
      if (result.duplicate) return res.status(200).json({ success: true, duplicate: true, messageId: result.message.id, status: result.message.status, doNumber: result.message.do_number });
      res.status(202).json({
        success: true,
        duplicate: false,
        messageId: result.inboundMessageId,
        orders: result.orders,
        acknowledgments: result.acknowledgments,
      });
    } catch (error) {
      try { await recordRejected(req.body, error, meta); } catch (logError) { console.error(JSON.stringify({ level: 'error', event: 'rejection_log_failed', message: logError.message })); }
      if (error instanceof X12Error) return res.status(error.status).json({ success: false, error: error.message, code: error.code, requestId: req.requestId });
      next(error);
    }
  }
);

module.exports = router;
