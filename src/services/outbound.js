const db = require('../db');
const config = require('../config');

let timer = null;
let running = false;

function retryDelay(attempt) {
  return Math.min(60 * 60 * 1000, Math.max(30 * 1000, (2 ** Math.max(0, attempt - 1)) * 30 * 1000));
}

function outboundHeaders(message) {
  const headers = {
    'content-type': 'application/edi-x12',
    'x-filename': message.filename || `${message.message_type}_${message.id}.edi`,
    'x-correlation-id': message.correlation_id || String(message.id),
    'user-agent': 'RayLand-BusinessOS-EDI/2.0',
  };
  if (config.outbound.token) {
    headers[config.outbound.tokenHeader] = config.outbound.tokenHeader === 'authorization'
      ? `${config.outbound.tokenScheme} ${config.outbound.token}`.trim()
      : config.outbound.token;
  }
  return headers;
}

async function claimNext() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT * FROM edi_messages
      WHERE direction='outbound'
        AND status IN ('queued','retrying')
        AND COALESCE(next_attempt_at, NOW()) <= NOW()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    if (!result.rows.length) {
      await client.query('COMMIT');
      return null;
    }
    const message = result.rows[0];
    await client.query(`UPDATE edi_messages SET status='sending', attempts=attempts+1, updated_at=NOW() WHERE id=$1`, [message.id]);
    await client.query('COMMIT');
    return { ...message, attempts: message.attempts + 1 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deliver(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.outbound.timeoutMs);
  try {
    const response = await fetch(config.outbound.url, {
      method: 'POST',
      headers: outboundHeaders(message),
      body: message.raw_edi,
      signal: controller.signal,
    });
    const text = (await response.text()).slice(0, 1000);
    if (!response.ok) throw Object.assign(new Error(`GEX returned HTTP ${response.status}`), { httpStatus: response.status, responseText: text });
    await db.query(`
      UPDATE edi_messages SET status='delivered', delivered_at=NOW(), http_status=$2,
        response_excerpt=$3, error_message=NULL, updated_at=NOW()
      WHERE id=$1
    `, [message.id, response.status, text]);
    console.log(JSON.stringify({ level: 'info', event: 'edi_delivered', id: message.id, type: message.message_type, httpStatus: response.status }));
  } catch (error) {
    const exhausted = message.attempts >= config.outbound.maxAttempts;
    const next = new Date(Date.now() + retryDelay(message.attempts));
    await db.query(`
      UPDATE edi_messages SET status=$2, next_attempt_at=$3, http_status=$4,
        response_excerpt=$5, error_message=$6, updated_at=NOW()
      WHERE id=$1
    `, [
      message.id, exhausted ? 'failed' : 'retrying', exhausted ? null : next,
      error.httpStatus || null, error.responseText || null,
      error.name === 'AbortError' ? 'Outbound request timed out' : error.message,
    ]);
    console.error(JSON.stringify({ level: 'error', event: 'edi_delivery_failed', id: message.id, attempt: message.attempts, exhausted, message: error.message }));
  } finally {
    clearTimeout(timeout);
  }
}

async function runOnce() {
  if (running || config.outbound.mode !== 'http' || !config.outbound.url) return;
  running = true;
  try {
    let message;
    while ((message = await claimNext())) await deliver(message);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'outbound_worker_error', message: error.message }));
  } finally {
    running = false;
  }
}

function startOutboundWorker() {
  if (timer) return;
  timer = setInterval(runOnce, config.outbound.pollMs);
  timer.unref();
  runOnce();
}

function stopOutboundWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function retryMessage(id) {
  const result = await db.query(`
    UPDATE edi_messages SET status='queued', next_attempt_at=NOW(), error_message=NULL, updated_at=NOW()
    WHERE id=$1 AND direction='outbound' AND status IN ('failed','retrying')
    RETURNING id, status
  `, [id]);
  if (result.rows.length) setImmediate(runOnce);
  return result.rows[0] || null;
}

module.exports = { startOutboundWorker, stopOutboundWorker, retryMessage, runOnce };
