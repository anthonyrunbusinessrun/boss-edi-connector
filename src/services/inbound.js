const crypto = require('crypto');
const db = require('../db');
const { parse850, generate997, X12Error } = require('./x12');

async function nextControl(client) {
  const result = await client.query("SELECT nextval('edi_control_number_seq') AS value");
  return result.rows[0].value;
}

async function ensureSequence(client) {
  await client.query('CREATE SEQUENCE IF NOT EXISTS edi_control_number_seq START 1');
}

async function saveOrder(client, order, inboundMessageId, envelope) {
  await client.query(`
    INSERT INTO orders (
      do_number, order_type, status, fund_cite, fund_doc_control, rrf_number,
      requested_delivery, latest_arrival, origin_facility, origin_address,
      destination_facility, destination_address, notes, source_message_id,
      sender_id, receiver_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (do_number) DO UPDATE SET
      order_type=EXCLUDED.order_type, status=EXCLUDED.status,
      fund_cite=EXCLUDED.fund_cite, fund_doc_control=EXCLUDED.fund_doc_control,
      rrf_number=EXCLUDED.rrf_number, requested_delivery=EXCLUDED.requested_delivery,
      latest_arrival=EXCLUDED.latest_arrival, origin_facility=EXCLUDED.origin_facility,
      origin_address=EXCLUDED.origin_address, destination_facility=EXCLUDED.destination_facility,
      destination_address=EXCLUDED.destination_address, notes=EXCLUDED.notes,
      source_message_id=EXCLUDED.source_message_id, sender_id=EXCLUDED.sender_id,
      receiver_id=EXCLUDED.receiver_id, updated_at=NOW()
  `, [
    order.doNumber, order.orderType, order.status, order.fundCite, order.fundDocControl,
    order.rrfNumber, order.requestedDelivery, order.latestArrival, order.originFacility,
    order.originAddress, order.destinationFacility, order.destinationAddress, order.notes,
    inboundMessageId, envelope.senderId, envelope.receiverId,
  ]);

  await client.query('DELETE FROM order_lines WHERE do_number=$1', [order.doNumber]);
  for (const line of order.lines) {
    await client.query(`
      INSERT INTO order_lines (do_number, line_number, sku, quantity, unit, description, product_class)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [order.doNumber, line.lineNumber, line.sku, line.quantity, line.unit, line.description, line.identifiers?.CL || null]);
  }
}

async function processInbound850(raw, meta = {}) {
  const parsed = parse850(raw);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await ensureSequence(client);
    const insert = await client.query(`
      INSERT INTO edi_messages (
        message_hash, direction, message_type, status, filename, partner, correlation_id,
        interchange_control, group_control, transaction_control, do_number, raw_edi
      ) VALUES ($1,'inbound','850','processing',$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (direction, message_hash) DO NOTHING
      RETURNING id
    `, [
      parsed.messageHash, meta.filename || null, meta.partner || parsed.senderId,
      meta.correlationId || null, parsed.interchangeControl, parsed.groupControl,
      parsed.transactions[0].transactionControl, parsed.transactions[0].doNumber, parsed.raw,
    ]);

    if (!insert.rows.length) {
      const existing = await client.query("SELECT id, status, do_number FROM edi_messages WHERE direction='inbound' AND message_hash=$1", [parsed.messageHash]);
      await client.query('COMMIT');
      return { duplicate: true, message: existing.rows[0] };
    }

    const inboundMessageId = insert.rows[0].id;
    for (const order of parsed.transactions) {
      await saveOrder(client, order, inboundMessageId, parsed);
    }
    const control = await nextControl(client);
    const ack = generate997(parsed, parsed.transactions, control, true);
    const ackHash = crypto.createHash('sha256').update(ack).digest('hex');
    const ackInsert = await client.query(`
      INSERT INTO edi_messages (
        message_hash, direction, message_type, status, filename, partner,
        correlation_id, related_message_id, transaction_control, do_number,
        raw_edi, next_attempt_at
      ) VALUES ($1,'outbound','997','queued',$2,$3,$4,$5,$6,$7,$8,NOW())
      RETURNING id, status
    `, [
      ackHash, `997_${parsed.groupControl}_${control}.edi`, parsed.senderId,
      meta.correlationId || null, inboundMessageId, String(control), parsed.transactions[0].doNumber, ack,
    ]);
    await client.query("UPDATE edi_messages SET status='processed', updated_at=NOW() WHERE id=$1", [inboundMessageId]);
    await client.query('COMMIT');
    return {
      duplicate: false,
      inboundMessageId,
      orders: parsed.transactions.map(item => item.doNumber),
      acknowledgments: [ackInsert.rows[0]],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordRejected(raw, error, meta = {}) {
  const normalized = String(raw || '').trim();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  await db.query(`
    INSERT INTO edi_messages (message_hash, direction, message_type, status, filename, partner, correlation_id, raw_edi, error_message)
    VALUES ($1,'inbound','unknown','rejected',$2,$3,$4,$5,$6)
    ON CONFLICT (direction, message_hash) DO UPDATE SET error_message=EXCLUDED.error_message, updated_at=NOW()
  `, [hash, meta.filename || null, meta.partner || null, meta.correlationId || null, normalized, error.message]);
}

module.exports = { processInbound850, recordRejected, X12Error };
