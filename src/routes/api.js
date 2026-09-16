const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { requireAdmin } = require('../middleware/auth');
const { retryMessage } = require('../services/outbound');

const router = express.Router();
router.use(requireAdmin);

const SHIPMENT_STATUSES = new Set(['draft', 'ready_to_ship', 'in_transit', 'delivered', 'cancelled']);

function text(value, max = 100) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function quantity(value, field) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    const error = new Error(`${field} must be a non-negative number`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function makeAsnId(doNumber) {
  const order = String(doNumber).replace(/[^a-zA-Z0-9]/g, '').slice(-20).toUpperCase();
  return `ASN-${order}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

router.get('/session', (req, res) => res.json({ success: true, user: { name: 'Administrator' } }));

router.get('/dashboard', async (req, res, next) => {
  try {
    const [orderStats, messageStats, shipmentStats, inventoryStats, recent] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE order_type='new')::int AS active FROM orders`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE direction='inbound' AND message_type='850')::int AS inbound_850,
        COUNT(*) FILTER (WHERE direction='outbound' AND message_type='997')::int AS outbound_997,
        COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('queued','retrying','sending'))::int AS pending,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed
        FROM edi_messages`),
      db.query(`SELECT
        COUNT(*)::int AS shipments,
        COUNT(*) FILTER (WHERE status='draft')::int AS draft_asns,
        COUNT(*) FILTER (WHERE status='ready_to_ship')::int AS ready_to_ship,
        COUNT(*) FILTER (WHERE status='in_transit')::int AS in_transit,
        COUNT(*) FILTER (WHERE status='delivered')::int AS delivered
        FROM shipments`),
      db.query(`SELECT COUNT(DISTINCT sku)::int AS inventory_skus
        FROM order_lines WHERE sku IS NOT NULL AND sku <> ''`),
      db.query(`SELECT id, direction, message_type, status, do_number, filename, attempts, error_message, created_at, delivered_at
        FROM edi_messages ORDER BY created_at DESC LIMIT 8`),
    ]);
    res.json({
      success: true,
      counts: { ...orderStats.rows[0], ...messageStats.rows[0], ...shipmentStats.rows[0], ...inventoryStats.rows[0] },
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

router.get('/inventory', async (req, res, next) => {
  try {
    const result = await db.query(`
      WITH demand AS (
        SELECT sku, MAX(description) AS description, MAX(unit) AS unit,
          SUM(quantity)::numeric AS ordered_quantity,
          COUNT(DISTINCT do_number)::int AS order_count
        FROM order_lines
        WHERE sku IS NOT NULL AND sku <> ''
        GROUP BY sku
      ), shipped AS (
        SELECT sl.sku,
          SUM(CASE WHEN s.status <> 'cancelled' THEN sl.quantity ELSE 0 END)::numeric AS shipped_quantity
        FROM shipment_lines sl JOIN shipments s ON s.asn_id=sl.asn_id
        WHERE sl.sku IS NOT NULL AND sl.sku <> ''
        GROUP BY sl.sku
      )
      SELECT COALESCE(i.sku, d.sku) AS sku,
        COALESCE(i.description, d.description) AS description,
        COALESCE(i.unit, d.unit, 'UN') AS unit,
        COALESCE(i.on_hand, 0)::numeric AS on_hand,
        COALESCE(i.allocated, 0)::numeric AS allocated,
        COALESCE(i.reorder_point, 0)::numeric AS reorder_point,
        i.location,
        COALESCE(d.ordered_quantity, 0)::numeric AS ordered_quantity,
        COALESCE(s.shipped_quantity, 0)::numeric AS shipped_quantity,
        GREATEST(COALESCE(d.ordered_quantity, 0) - COALESCE(s.shipped_quantity, 0), 0)::numeric AS remaining_to_ship,
        (COALESCE(i.on_hand, 0) - COALESCE(i.allocated, 0))::numeric AS available,
        COALESCE(d.order_count, 0)::int AS order_count,
        i.updated_at
      FROM inventory_items i
      FULL OUTER JOIN demand d ON d.sku=i.sku
      LEFT JOIN shipped s ON s.sku=COALESCE(i.sku, d.sku)
      ORDER BY COALESCE(i.sku, d.sku)
    `);
    const summary = result.rows.reduce((totals, item) => {
      totals.skus += 1;
      totals.onHand += Number(item.on_hand);
      totals.allocated += Number(item.allocated);
      totals.remaining += Number(item.remaining_to_ship);
      if (item.updated_at && Number(item.available) <= Number(item.reorder_point)) totals.lowStock += 1;
      return totals;
    }, { skus: 0, onHand: 0, allocated: 0, remaining: 0, lowStock: 0 });
    res.json({ success: true, inventory: result.rows, summary });
  } catch (error) { next(error); }
});

router.put('/inventory/:sku', async (req, res, next) => {
  try {
    const sku = text(req.params.sku, 100);
    if (!sku) return res.status(400).json({ success: false, error: 'SKU is required' });
    const item = {
      description: text(req.body.description, 500),
      unit: text(req.body.unit, 10) || 'UN',
      onHand: quantity(req.body.onHand, 'On hand'),
      allocated: quantity(req.body.allocated, 'Allocated'),
      reorderPoint: quantity(req.body.reorderPoint, 'Reorder point'),
      location: text(req.body.location, 100),
    };
    const result = await db.query(`INSERT INTO inventory_items
      (sku, description, unit, on_hand, allocated, reorder_point, location, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (sku) DO UPDATE SET
        description=COALESCE(EXCLUDED.description, inventory_items.description),
        unit=EXCLUDED.unit, on_hand=EXCLUDED.on_hand, allocated=EXCLUDED.allocated,
        reorder_point=EXCLUDED.reorder_point, location=EXCLUDED.location, updated_at=NOW()
      RETURNING *`, [sku, item.description, item.unit, item.onHand, item.allocated, item.reorderPoint, item.location]);
    res.json({ success: true, item: result.rows[0] });
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
    const result = await db.query(`SELECT s.*, COUNT(sl.id)::int AS line_count,
      COALESCE(SUM(sl.quantity), 0)::numeric AS total_units,
      o.requested_delivery, o.destination_address
      FROM shipments s
      LEFT JOIN shipment_lines sl ON sl.asn_id=s.asn_id
      LEFT JOIN orders o ON o.do_number=s.do_number
      GROUP BY s.id, o.requested_delivery, o.destination_address
      ORDER BY s.created_at DESC LIMIT 250`);
    res.json({ success: true, shipments: result.rows, edi856Enabled: config.edi.enable856 });
  } catch (error) { next(error); }
});

router.post('/shipments', async (req, res, next) => {
  let client;
  try {
    client = await db.connect();
    const doNumber = text(req.body.doNumber, 50);
    if (!doNumber) return res.status(400).json({ success: false, error: 'Order is required' });
    const order = await client.query('SELECT * FROM orders WHERE do_number=$1', [doNumber]);
    if (!order.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    const asnId = text(req.body.asnId, 100) || makeAsnId(doNumber);
    await client.query('BEGIN');
    const created = await client.query(`INSERT INTO shipments
      (asn_id, do_number, status, carrier, tracking_number, bol_number, trailer_number,
       tractor_number, ship_date, eta, origin_facility, destination_facility, notes, updated_at)
      VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *`, [
      asnId, doNumber, text(req.body.carrier), text(req.body.trackingNumber), text(req.body.bolNumber),
      text(req.body.trailerNumber), text(req.body.tractorNumber), text(req.body.shipDate, 20),
      text(req.body.eta, 20), order.rows[0].origin_facility, order.rows[0].destination_facility,
      text(req.body.notes, 1000),
    ]);
    await client.query(`INSERT INTO shipment_lines (asn_id, sku, quantity, unit)
      SELECT $1, sku, quantity, unit FROM order_lines WHERE do_number=$2`, [asnId, doNumber]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, shipment: created.rows[0] });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'ASN ID already exists' });
    next(error);
  } finally { if (client) client.release(); }
});

router.patch('/shipments/:asnId', async (req, res, next) => {
  try {
    const status = text(req.body.status, 50);
    if (status && !SHIPMENT_STATUSES.has(status)) {
      return res.status(400).json({ success: false, error: 'Invalid shipment status' });
    }
    const result = await db.query(`UPDATE shipments SET
      status=COALESCE($2,status), carrier=COALESCE($3,carrier),
      tracking_number=COALESCE($4,tracking_number), bol_number=COALESCE($5,bol_number),
      trailer_number=COALESCE($6,trailer_number), tractor_number=COALESCE($7,tractor_number),
      ship_date=COALESCE($8, CASE WHEN $2='in_transit' THEN TO_CHAR(CURRENT_DATE,'YYYYMMDD') ELSE ship_date END),
      eta=COALESCE($9,eta), notes=COALESCE($10,notes),
      delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE delivered_at END,
      updated_at=NOW()
      WHERE asn_id=$1 RETURNING *`, [
      req.params.asnId, status, text(req.body.carrier), text(req.body.trackingNumber),
      text(req.body.bolNumber), text(req.body.trailerNumber), text(req.body.tractorNumber),
      text(req.body.shipDate, 20), text(req.body.eta, 20), text(req.body.notes, 1000),
    ]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'ASN not found' });
    res.json({ success: true, shipment: result.rows[0] });
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
