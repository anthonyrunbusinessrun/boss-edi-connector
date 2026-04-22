const express = require('express');
const router = express.Router();
const { parse850 } = require('../parsers/parse850');
const { generate997 } = require('../parsers/generate997');
const fs = require('fs');
const path = require('path');
const db = require('../db');

router.post('/inbound', async (req, res) => {
  try {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', async () => {
      const filename = req.headers['x-filename'] || `edi_${Date.now()}.edi`;
      console.log(`📥 Inbound EDI received: ${filename}`);

      const inboxPath = process.env.OPENAS2_INBOX || './data/inbox';
      if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true });

      const filePath = path.join(inboxPath, filename);
      fs.writeFileSync(filePath, raw);

      if (raw.includes('*850*')) {
        await parse850(filePath);
        await generate997(filePath);
        res.json({ success: true, type: '850', message: 'Purchase order processed' });
      } else if (raw.includes('*997*')) {
        await db.query(`INSERT INTO edi_log (direction, message_type, status, raw_edi) VALUES ('inbound', '997', 'received', $1)`, [raw]);
        res.json({ success: true, type: '997', message: 'Acknowledgment received' });
      } else {
        res.json({ success: true, type: 'unknown', message: 'Message logged' });
      }
    });
  } catch (err) {
    console.error('❌ Inbound EDI error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'BusinessOS EDI Connector',
    as2_id: process.env.RAY_ISA_ID || '3863629312',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
