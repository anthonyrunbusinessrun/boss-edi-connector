require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

// Start inbox watcher
require('./src/watcher/inbox');

// API routes
app.use('/orders', require('./src/routes/orders'));
app.use('/shipments', require('./src/routes/shipments'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BusinessOS EDI Service running on port ${PORT}`);
});
