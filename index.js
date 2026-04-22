require('dotenv').config();
const express = require('express');
const app = express();

// AS2 endpoint — for GEX pushing via AS2 protocol (port 4080)
app.use('/as2', require('./src/as2/as2handler'));

// HTTPS EDI endpoint — for direct HTTPS posting
app.use('/edi', require('./src/as2/receiver'));

app.use(express.json());

// Start inbox watcher
require('./src/watcher/inbox');

// API routes
app.use('/orders', require('./src/routes/orders'));
app.use('/shipments', require('./src/routes/shipments'));

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'BusinessOS EDI Connector',
    version: '1.0.0',
    endpoints: {
      as2: '/as2',
      edi_https: '/edi/inbound',
      health: '/edi/health',
      orders: '/orders',
      shipments: '/shipments/dispatch'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BusinessOS EDI Service running on port ${PORT}`);
  console.log(`📡 AS2 endpoint:   POST /as2`);
  console.log(`📡 HTTPS endpoint: POST /edi/inbound`);
  console.log(`❤️  Health check:  GET /edi/health`);
});
