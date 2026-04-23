require('dotenv').config();
const express = require('express');
const app = express();

// ── CORS — allow dashboard and any GEX/AS2 caller ──────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, AS2-From, AS2-To, AS2-Version, Message-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/as2', require('./src/as2/as2handler'));
app.use('/edi', require('./src/as2/receiver'));
app.use(express.json());

require('./src/watcher/inbox');

app.use('/orders', require('./src/routes/orders'));
app.use('/shipments', require('./src/routes/shipments'));

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'BusinessOS EDI Connector',
    version: '1.0.0',
    endpoints: {
      as2:       '/as2',
      edi_https: '/edi/inbound',
      health:    '/edi/health',
      orders:    '/orders',
      dispatch:  '/shipments/dispatch'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 BusinessOS EDI Service running on port ' + PORT);
  console.log('📡 AS2 endpoint:   POST /as2');
  console.log('📡 HTTPS endpoint: POST /edi/inbound');
  console.log('❤️  Health check:  GET /edi/health');
});
