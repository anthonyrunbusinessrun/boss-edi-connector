require('dotenv').config();
const express = require('express');
const app = express();

app.use('/edi', require('./src/as2/receiver'));
app.use(express.json());

require('./src/watcher/inbox');

app.use('/orders', require('./src/routes/orders'));
app.use('/shipments', require('./src/routes/shipments'));

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'BusinessOS EDI Connector', version: '1.0.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BusinessOS EDI Service running on port ${PORT}`);
  console.log(`📡 EDI endpoint: POST /edi/inbound`);
  console.log(`❤️  Health check: GET /edi/health`);
});
