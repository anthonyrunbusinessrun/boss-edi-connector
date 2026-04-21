const fs = require('fs');
const path = require('path');
const db = require('../db');

async function generate997(original850Path) {
  const raw = fs.readFileSync(original850Path, 'utf8');

  // Extract control numbers from the original 850
  const isaMatch = raw.match(/ISA\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*(\d{6})\*(\d{4})\*[^*]*\*[^*]*\*(\d{9})/);
  const gsMatch = raw.match(/GS\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*(\d+)/);
  const stMatch = raw.match(/ST\*850\*(\w+)/);

  const isaControl = isaMatch?.[3] || '000000001';
  const gsControl = gsMatch?.[1] || '1';
  const stControl = stMatch?.[1] || '0001';

  // Build 997 using confirmed FEMA credentials
  const senderId = process.env.RAY_ISA_ID || '3863629312';
  const receiverId = process.env.NODE_ENV === 'production'
    ? (process.env.FEMA_ISA_PROD || '521227911')
    : (process.env.FEMA_ISA_TEST || '521227911TDL');

  const now = new Date();
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  const fullDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toTimeString().slice(0, 5).replace(':', '');

  const ack997 = [
    `ISA*00*          *00*          *12*${senderId.padEnd(15)}*ZZ*${receiverId.padEnd(15)}*${date}*${time}*U*00401*${isaControl}*0*P*>~`,
    `GS*FA*${senderId}*${receiverId}*${fullDate}*${time}*${gsControl}*X*004010~`,
    `ST*997*${stControl}~`,
    `AK1*PO*${gsControl}~`,
    `AK2*850*${stControl}~`,
    `AK5*A~`,
    `AK9*A*1*1*1~`,
    `SE*6*${stControl}~`,
    `GE*1*${gsControl}~`,
    `IEA*1*${isaControl}~`
  ].join('\n');

  // Write to OpenAS2 outbox for sending
  const outboxPath = process.env.OPENAS2_OUTBOX || './test/outbox';
  if (!fs.existsSync(outboxPath)) {
    fs.mkdirSync(outboxPath, { recursive: true });
  }

  const outFile = path.join(outboxPath, `997_${stControl}_${Date.now()}.edi`);
  fs.writeFileSync(outFile, ack997);
  console.log(`📤 997 acknowledgment queued: ${path.basename(outFile)}`);

  // Log it
  await db.query(`
    INSERT INTO edi_log (direction, message_type, status, raw_edi)
    VALUES ('outbound', '997', 'sent', $1)
  `, [ack997]);
}

module.exports = { generate997 };
