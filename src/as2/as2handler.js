const express = require('express');
const router = express.Router();
const { parse850 } = require('../parsers/parse850');
const { generate997 } = require('../parsers/generate997');
const fs = require('fs');
const path = require('path');
const db = require('../db');

// AS2 receiver endpoint — handles GEX pushing 850s via AS2 protocol
router.post('/', async (req, res) => {
  try {
    const messageId = req.headers['message-id'] || req.headers['as2-message-id'] || `MSG-${Date.now()}`;
    const from = req.headers['as2-from'] || 'GEX_FEMA';
    const to = req.headers['as2-to'] || '3863629312';

    console.log(`📨 AS2 message received`);
    console.log(`   From: ${from}`);
    console.log(`   To:   ${to}`);
    console.log(`   ID:   ${messageId}`);

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {

      // Save raw EDI to inbox
      const inboxPath = process.env.OPENAS2_INBOX || './data/inbox';
      if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true });
      const filename = `${messageId.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.edi`;
      const filePath = path.join(inboxPath, filename);
      fs.writeFileSync(filePath, body);

      try {
        if (body.includes('*850*')) {
          await parse850(filePath);
          await generate997(filePath);
          console.log(`✅ AS2 850 processed: ${filename}`);
        } else if (body.includes('*997*')) {
          await db.query(
            `INSERT INTO edi_log (direction, message_type, status, raw_edi) VALUES ('inbound', '997', 'received', $1)`,
            [body]
          );
          console.log(`✅ AS2 997 received: ${filename}`);
        }
      } catch (parseErr) {
        console.error(`❌ Parse error: ${parseErr.message}`);
      }

      // Send AS2 MDN acknowledgment back to GEX
      const mdn = [
        `Message-ID: <MDN-${Date.now()}@businessos.rayland.com>`,
        `AS2-From: ${to}`,
        `AS2-To: ${from}`,
        `AS2-Version: 1.2`,
        `Original-Message-ID: ${messageId}`,
        `Disposition: automatic-action/MDN-sent-automatically; processed`,
        ``,
        `The message was successfully received and processed.`
      ].join('\r\n');

      res.set({
        'Content-Type': 'message/disposition-notification',
        'AS2-From': to,
        'AS2-To': from,
        'AS2-Version': '1.2',
        'Message-ID': `<MDN-${Date.now()}@businessos.rayland.com>`,
        'Disposition': 'automatic-action/MDN-sent-automatically; processed'
      });
      res.status(200).send(mdn);
    });

  } catch (err) {
    console.error(`❌ AS2 handler error: ${err.message}`);
    res.status(500).send('Error processing AS2 message');
  }
});

// AS2 health/ping endpoint GEX uses to verify connection
router.get('/', (req, res) => {
  res.set({
    'AS2-From': process.env.RAY_ISA_ID || '3863629312',
    'AS2-Version': '1.2',
    'Content-Type': 'text/plain'
  });
  res.send('BusinessOS AS2 Endpoint Ready');
});

module.exports = router;
