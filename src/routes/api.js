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
      db.query(`SELECT id, direction, message_type, status, do_number, filename, attempts, error_message, created_at, delivered_at
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

router.get('/integrations', async (req, res, next) => {
  try {
    const [messageCounts, lastInbound, lastOutbound] = await Promise.all([
      db.query(`SELECT
        COUNT(*) FILTER (WHERE direction='inbound')::int AS inbound,
        COUNT(*) FILTER (WHERE direction='outbound')::int AS outbound,
        COUNT(*) FILTER (WHERE status IN ('failed','rejected'))::int AS exceptions
        FROM edi_messages`),
      db.query(`SELECT created_at, status, do_number FROM edi_messages
        WHERE direction='inbound' ORDER BY created_at DESC LIMIT 1`),
      db.query(`SELECT created_at, status, do_number FROM edi_messages
        WHERE direction='outbound' ORDER BY created_at DESC LIMIT 1`),
    ]);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      summary: messageCounts.rows[0],
      partner: {
        code: 'FEMA-GEX', name: 'FEMA through DAAS GEX', environment: 'test onboarding',
        transport: 'Authenticated HTTPS 443', status: 'partner_testing_required',
        rayIsaId: config.edi.rayIsaId, rayIsaQualifier: config.edi.rayIsaQualifier,
        inboundEndpoint: `${baseUrl}/edi/inbound`,
      },
      connections: [
        { id: 'gex-inbound', name: 'GEX inbound gateway', kind: 'Partner HTTPS', direction: 'inbound', status: config.inbound.token ? 'configured' : 'configuration_required', detail: 'Receives X12 over authenticated HTTPS 443', lastActivity: lastInbound.rows[0] || null },
        { id: 'gex-outbound', name: 'GEX return route', kind: 'Partner HTTPS', direction: 'outbound', status: config.outbound.mode === 'http' && config.outbound.url ? 'configured' : 'awaiting_gex', detail: 'Returns 997 acknowledgments after GEX supplies its approved URL', lastActivity: lastOutbound.rows[0] || null },
        { id: 'operations-api', name: 'BusinessOS operations API', kind: 'Internal API', direction: 'bidirectional', status: 'configured', detail: 'Orders, inventory, shipments, ASNs, and audit data' },
        { id: 'erp-wms', name: 'ERP / WMS integration', kind: 'API or flat file', direction: 'bidirectional', status: 'not_configured', detail: 'Available after Ray Land selects the target ERP or warehouse system' },
      ],
      documents: [
        { transaction: '850', name: 'Purchase order', direction: 'inbound', version: '004010', workflow: 'Validate → map → order → 997', status: 'ready_for_partner_test' },
        { transaction: '997', name: 'Functional acknowledgment', direction: 'outbound', version: '004010', workflow: 'Generate → queue → deliver → audit', status: config.outbound.mode === 'http' ? 'configured' : 'awaiting_return_route' },
        { transaction: '856', name: 'Advance shipment notice', direction: 'outbound', version: 'Pending guide', workflow: 'Draft → validate → approve → transmit', status: config.edi.enable856 ? 'configured' : 'internal_draft_only' },
      ],
      onboarding: [
        { name: 'Trading-partner agreement', owner: 'Ray Land / FEMA / GEX', status: 'action_required', detail: 'Complete the new Ray Land agreement and connected-partner updates.' },
        { name: 'Addressing and identifiers', owner: 'DLA EDI Group', status: 'in_progress', detail: `Confirm ISA/GS routing for ${config.edi.rayIsaId}.` },
        { name: 'Inbound connectivity', owner: 'Ray Land', status: config.inbound.token ? 'ready' : 'action_required', detail: 'HTTPS endpoint, authentication, validation, and duplicate protection.' },
        { name: 'Document mapping', owner: 'Ray Land / GEX', status: 'in_progress', detail: '850 and 997 implemented locally; partner implementation guide confirmation remains.' },
        { name: 'Partner certification testing', owner: 'GEX testing team', status: 'not_started', detail: 'Execute approved test cases and capture evidence for each production path.' },
        { name: 'Production authorization', owner: 'GEX production', status: 'blocked', detail: 'Requires agreements, testing, firewall validation, account setup, and IDG.' },
      ],
    });
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
          SUM(CASE WHEN s.status IN ('in_transit','delivered') THEN sl.quantity ELSE 0 END)::numeric AS shipped_quantity
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

router.delete('/inventory/:sku', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM inventory_items WHERE sku=$1 RETURNING sku', [req.params.sku]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Inventory record not found' });
    res.json({ success: true, deleted: result.rows[0].sku });
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

router.get('/shipments/:asnId', async (req, res, next) => {
  try {
    const shipment = await db.query('SELECT * FROM shipments WHERE asn_id=$1', [req.params.asnId]);
    if (!shipment.rows.length) return res.status(404).json({ success: false, error: 'ASN not found' });
    const lines = await db.query(`SELECT sl.id, sl.sku, sl.quantity, sl.unit, sl.lot_number,
      sl.expiration_date, sl.manufacturer, MAX(ol.description) AS description
      FROM shipment_lines sl
      LEFT JOIN order_lines ol ON ol.do_number=$2 AND ol.sku=sl.sku
      WHERE sl.asn_id=$1
      GROUP BY sl.id ORDER BY sl.id`, [req.params.asnId, shipment.rows[0].do_number]);
    res.json({ success: true, shipment: shipment.rows[0], lines: lines.rows, edi856Enabled: config.edi.enable856 });
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
    const has = key => Object.prototype.hasOwnProperty.call(req.body, key);
    if (status && !SHIPMENT_STATUSES.has(status)) {
      return res.status(400).json({ success: false, error: 'Invalid shipment status' });
    }
    const result = await db.query(`UPDATE shipments SET
      status=COALESCE($2,status),
      carrier=CASE WHEN $3 THEN $4 ELSE carrier END,
      tracking_number=CASE WHEN $5 THEN $6 ELSE tracking_number END,
      bol_number=CASE WHEN $7 THEN $8 ELSE bol_number END,
      trailer_number=CASE WHEN $9 THEN $10 ELSE trailer_number END,
      tractor_number=CASE WHEN $11 THEN $12 ELSE tractor_number END,
      ship_date=CASE WHEN $13 THEN $14 WHEN $2='in_transit' THEN TO_CHAR(CURRENT_DATE,'YYYYMMDD') ELSE ship_date END,
      eta=CASE WHEN $15 THEN $16 ELSE eta END,
      notes=CASE WHEN $17 THEN $18 ELSE notes END,
      delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE delivered_at END,
      updated_at=NOW()
      WHERE asn_id=$1 RETURNING *`, [
      req.params.asnId, status,
      has('carrier'), text(req.body.carrier),
      has('trackingNumber'), text(req.body.trackingNumber),
      has('bolNumber'), text(req.body.bolNumber),
      has('trailerNumber'), text(req.body.trailerNumber),
      has('tractorNumber'), text(req.body.tractorNumber),
      has('shipDate'), text(req.body.shipDate, 20),
      has('eta'), text(req.body.eta, 20),
      has('notes'), text(req.body.notes, 1000),
    ]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'ASN not found' });
    res.json({ success: true, shipment: result.rows[0] });
  } catch (error) { next(error); }
});

router.put('/shipments/:asnId/lines', async (req, res, next) => {
  let client;
  try {
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ success: false, error: 'At least one shipment line is required' });
    const normalized = lines.map((line, index) => {
      const sku = text(line.sku, 100);
      const amount = quantity(line.quantity, `Line ${index + 1} quantity`);
      if (!sku || amount <= 0) {
        const error = new Error(`Line ${index + 1} requires a SKU and a quantity greater than zero`);
        error.status = 400;
        throw error;
      }
      return {
        sku,
        quantity: amount,
        unit: text(line.unit, 10) || 'EA',
        lotNumber: text(line.lotNumber, 100),
        expirationDate: text(line.expirationDate, 20),
        manufacturer: text(line.manufacturer, 100),
      };
    });
    client = await db.connect();
    await client.query('BEGIN');
    const shipment = await client.query('SELECT status FROM shipments WHERE asn_id=$1 FOR UPDATE', [req.params.asnId]);
    if (!shipment.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'ASN not found' });
    }
    if (shipment.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Shipment lines can only be changed while the ASN is a draft' });
    }
    await client.query('DELETE FROM shipment_lines WHERE asn_id=$1', [req.params.asnId]);
    for (const line of normalized) {
      await client.query(`INSERT INTO shipment_lines
        (asn_id, sku, quantity, unit, lot_number, expiration_date, manufacturer)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        req.params.asnId, line.sku, line.quantity, line.unit,
        line.lotNumber, line.expirationDate, line.manufacturer,
      ]);
    }
    await client.query('UPDATE shipments SET updated_at=NOW() WHERE asn_id=$1', [req.params.asnId]);
    await client.query('COMMIT');
    res.json({ success: true, lines: normalized });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { if (client) client.release(); }
});

router.delete('/shipments/:asnId', async (req, res, next) => {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const shipment = await client.query('SELECT asn_id, status FROM shipments WHERE asn_id=$1 FOR UPDATE', [req.params.asnId]);
    if (!shipment.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'ASN not found' });
    }
    if (shipment.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Only draft ASNs can be deleted. Cancel an active shipment instead.' });
    }
    await client.query('DELETE FROM shipment_lines WHERE asn_id=$1', [req.params.asnId]);
    await client.query('DELETE FROM shipments WHERE asn_id=$1', [req.params.asnId]);
    await client.query('COMMIT');
    res.json({ success: true, deleted: req.params.asnId });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { if (client) client.release(); }
});

router.post('/shipments/:asnId/send', async (req, res, next) => {
  try {
    const shipment = await db.query('SELECT asn_id, status FROM shipments WHERE asn_id=$1', [req.params.asnId]);
    if (!shipment.rows.length) return res.status(404).json({ success: false, error: 'ASN not found' });
    if (shipment.rows[0].status === 'draft') return res.status(409).json({
      success: false,
      error: 'Mark the ASN ready to ship before sending it',
    });
    if (!config.edi.enable856) return res.status(409).json({
      success: false,
      error: 'EDI 856 sending is locked until FEMA/GEX approves the implementation guide and certification testing',
    });
    if (config.outbound.mode !== 'http' || !config.outbound.url) return res.status(409).json({
      success: false,
      error: 'The approved GEX outbound URL and authentication are not configured',
    });
    res.status(501).json({ success: false, error: 'The partner-approved 856 map must be installed before transmission can be enabled' });
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
