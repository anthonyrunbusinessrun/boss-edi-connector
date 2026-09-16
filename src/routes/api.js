const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAdmin } = require('../middleware/auth');
const { retryMessage } = require('../services/outbound');

const router = express.Router();
router.use(requireAdmin);

router.get('/session', (req, res) => res.json({ success: true, user: { name: 'Administrator' } }));

router.get('/dashboard', async (req, res, next) => {
  try {
    const [orderStats, messageStats, recent] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE order_type='new')::int AS active FROM orders`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE direction='inbound' AND message_type='850')::int AS inbound_850,
        COUNT(*) FILTER (WHERE direction='outbound' AND message_type='997')::int AS outbound_997,
        COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('queued','retrying','sending'))::int AS pending,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed
        FROM edi_messages`),
      db.query(`SELECT id, direction, message_type, status, do_number, filename, attempts, error_message, created_at, delivered_at
        FROM edi_messages ORDER BY created_at DESC LIMIT 8`),
    ]);
    res.json({
      success: true,
      counts: { ...orderStats.rows[0], ...messageStats.rows[0] },
      recentMessages: recent.rows,
      connection: {
        inbound: config.inbound.token ? 'configured' : 'configuration_required',
        outboundMode: config.outbound.mode,
        outbound: config.outbound.mode === 'http' && config.outbound.url ? 'configured' : 'manual',
        edi856Enabled: config.edi.enable856,
      },
    });
  } catch (error) { next(error); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT o.*, COUNT(ol.id)::int AS line_count,
        COALESCE((SELECT status FROM edi_messages em WHERE em.related_message_id=o.source_message_id AND em.message_type='997' ORDER BY em.created_at DESC LIMIT 1), 'not_created') AS acknowledgment_status
      FROM orders o LEFT JOIN order_lines ol ON ol.do_number=o.do_number
      GROUP BY o.id ORDER BY o.created_at DESC LIMIT 250
    `);
    res.json({ success: true, orders: result.rows });
  } catch (error) { next(error); }
});

router.get('/orders/:doNumber', async (req, res, next) => {
  try {
    const order = await db.query('SELECT * FROM orders WHERE do_number=$1', [req.params.doNumber]);
    if (!order.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    const [lines, messages, shipments] = await Promise.all([
      db.query('SELECT * FROM order_lines WHERE do_number=$1 ORDER BY line_number', [req.params.doNumber]),
      db.query(`SELECT id, direction, message_type, status, filename, attempts, error_message, created_at, delivered_at
        FROM edi_messages WHERE do_number=$1 ORDER BY created_at DESC`, [req.params.doNumber]),
      db.query('SELECT * FROM shipments WHERE do_number=$1 ORDER BY created_at DESC', [req.params.doNumber]),
    ]);
    res.json({ success: true, order: order.rows[0], lines: lines.rows, messages: messages.rows, shipments: shipments.rows });
  } catch (error) { next(error); }
});

router.get('/messages', async (req, res, next) => {
  try {
    const values = [];
    const filters = [];
    if (req.query.status) { values.push(req.query.status); filters.push(`status=$${values.length}`); }
    if (req.query.type) { values.push(req.query.type); filters.push(`message_type=$${values.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await db.query(`SELECT id, direction, message_type, status, filename, partner, correlation_id, do_number,
      attempts, http_status, error_message, created_at, delivered_at, updated_at
      FROM edi_messages ${where} ORDER BY created_at DESC LIMIT 250`, values);
    res.json({ success: true, messages: result.rows });
  } catch (error) { next(error); }
});

router.post('/messages/:id/retry', async (req, res, next) => {
  try {
    const message = await retryMessage(req.params.id);
    if (!message) return res.status(409).json({ success: false, error: 'Only failed or retrying outbound messages can be retried' });
    res.json({ success: true, message });
  } catch (error) { next(error); }
});

router.get('/shipments', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM shipments ORDER BY created_at DESC LIMIT 250');
    res.json({ success: true, shipments: result.rows, edi856Enabled: config.edi.enable856 });
  } catch (error) { next(error); }
});

router.post('/shipments/dispatch', (req, res) => {
  if (!config.edi.enable856) return res.status(409).json({
    success: false,
    error: 'EDI 856 is disabled until FEMA/GEX confirms it is in scope and provides the implementation guide',
  });
  res.status(501).json({ success: false, error: 'EDI 856 mapping is pending FEMA approval and test certification' });
});

module.exports = router;
