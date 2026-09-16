require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const config = require('./src/config');
const db = require('./src/db');
const { migrate } = require('./src/db/migrate');
const { startOutboundWorker, stopOutboundWorker } = require('./src/services/outbound');
const { applyCors, applySecurityHeaders } = require('./src/middleware/security');

const app = express();

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});
app.use(applySecurityHeaders);
app.use(applyCors);

app.use('/edi', require('./src/routes/edi'));
app.use('/api/auth', express.json({ limit: '16kb' }), require('./src/routes/auth'));
app.use('/api', express.json({ limit: '256kb' }), require('./src/routes/api'));

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Ray Land BusinessOS EDI Gateway',
    version: '2.0.0',
    endpoints: {
      inbound_https: '/edi/inbound',
      health: '/edi/health',
      login: '/api/auth/login'
    }
  });
});

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  console.error(JSON.stringify({
    level: 'error', requestId: req.requestId, status,
    message: err.message, stack: config.isProduction ? undefined : err.stack
  }));
  if (res.headersSent) return next(err);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Internal server error' : err.message,
    requestId: req.requestId
  });
});

let server;

async function start() {
  await migrate();
  await db.query('SELECT 1');
  server = app.listen(config.port, () => {
    console.log(JSON.stringify({
      level: 'info', event: 'service_started', port: config.port,
      environment: config.nodeEnv, outboundMode: config.outbound.mode
    }));
  });
  startOutboundWorker();
}

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
  stopOutboundWorker();
  if (server) await new Promise(resolve => server.close(resolve));
  await db.end();
}

if (require.main === module) {
  start().catch(err => {
    console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message: err.message }));
    process.exit(1);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => shutdown(signal).finally(() => process.exit(0)));
  }
}

module.exports = { app, start };
