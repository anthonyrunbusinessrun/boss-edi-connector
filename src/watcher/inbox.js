require('dotenv').config();
const chokidar = require('chokidar');
const path = require('path');
const { parse850 } = require('../parsers/parse850');
const { generate997 } = require('../parsers/generate997');

const inboxPath = process.env.OPENAS2_INBOX || './test/inbox';

// Ensure inbox folder exists
const fs = require('fs');
if (!fs.existsSync(inboxPath)) {
  fs.mkdirSync(inboxPath, { recursive: true });
  console.log(`📁 Created inbox folder: ${inboxPath}`);
}

console.log(`👀 Watching inbox: ${inboxPath}`);

chokidar.watch(inboxPath, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 }
}).on('add', async (filePath) => {
  const filename = path.basename(filePath);
  console.log(`📥 New EDI file received: ${filename}`);

  try {
    const raw = fs.readFileSync(filePath, 'utf8');

    // Detect message type from content
    if (raw.includes('*850*')) {
      console.log(`📋 Processing EDI 850 Purchase Order...`);
      await parse850(filePath);
      await generate997(filePath);
      console.log(`✅ 850 processed and 997 sent for: ${filename}`);
    } else {
      console.log(`⚠️  Unknown EDI type in file: ${filename}`);
    }
  } catch (err) {
    console.error(`❌ Failed to process ${filename}:`, err.message);
  }
});
