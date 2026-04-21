const fs = require('fs');
const path = require('path');
const db = require('../db');

async function generate856(shipmentData) {
  const {
    asnId, doNumber, trailerNumber, tractorNumber,
    plateNumber, plateState, shipDate, eta,
    originFacility, destinationFacility, items
  } = shipmentData;

  const senderId = process.env.RAY_ISA_ID || '3863629312';
  const receiverId = process.env.NODE_ENV === 'production'
    ? (process.env.FEMA_ISA_PROD || '521227911')
    : (process.env.FEMA_ISA_TEST || '521227911TDL');

  const now = new Date();
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  const fullDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toTimeString().slice(0, 5).replace(':', '');

  // Get next control number from DB
  const ctrlResult = await db.query(`SELECT COALESCE(MAX(CAST(control_number AS INTEGER)), 0) + 1 AS next FROM edi_log WHERE message_type = '856'`);
  const controlNum = String(ctrlResult.rows[0].next).padStart(9, '0');

  const lines = [
    `ISA*00*          *00*          *12*${senderId.padEnd(15)}*ZZ*${receiverId.padEnd(15)}*${date}*${time}*U*00401*${controlNum}*0*P*>~`,
    `GS*SH*${senderId}*${receiverId}*${fullDate}*${time}*${controlNum}*X*004010~`,
    `ST*856*${asnId}~`,
    `BSN*00*${asnId}*${fullDate}*${time}~`,
    `HL*0**S~`,
    `PRF*${doNumber}~`,
    `TD3*TL**${trailerNumber}~`,
    `TD3*TR**${tractorNumber}~`,
    `REF*LV*${plateNumber}*Plate Number~`,
    `REF*0B*${plateState}*Plate State~`,
    `DTM*011*${shipDate}~`,
    `DTM*017*${eta}~`,
    `N1*SF*${originFacility}~`,
    `N1*ST*${destinationFacility}~`,
  ];

  // Add item loops
  items.forEach((item, idx) => {
    lines.push(`HL*${idx + 1}**I~`);
    lines.push(`LIN*${idx + 1}*SK*${item.sku}~`);
    lines.push(`SN1*${idx + 1}*${item.quantity}*UN~`);

    if (item.manufacturer) {
      lines.push(`REF*MF*${item.manufacturer}*Manufacturer~`);
    }
    if (item.lotNumber) {
      lines.push(`REF*LT*${item.lotNumber}*Lot~`);
    }
    if (item.expirationDate) {
      lines.push(`DTM*036*${item.expirationDate}~`);
    }
  });

  const segmentCount = lines.length - 2 + 1; // exclude ISA/GS, add SE
  lines.push(`SE*${segmentCount}*${asnId}~`);
  lines.push(`GE*1*${controlNum}~`);
  lines.push(`IEA*1*${controlNum}~`);

  const edi856 = lines.join('\n');

  // Write to OpenAS2 outbox
  const outboxPath = process.env.OPENAS2_OUTBOX || './test/outbox';
  if (!fs.existsSync(outboxPath)) {
    fs.mkdirSync(outboxPath, { recursive: true });
  }

  const outFile = path.join(outboxPath, `856_${asnId}_${Date.now()}.edi`);
  fs.writeFileSync(outFile, edi856);
  console.log(`📤 856 ASN queued: ${path.basename(outFile)}`);

  // Save shipment to DB
  await db.query(`
    INSERT INTO shipments (asn_id, do_number, status, trailer_number, tractor_number,
      plate_number, plate_state, ship_date, eta, origin_facility, destination_facility)
    VALUES ($1,$2,'sent',$3,$4,$5,$6,$7,$8,$9,$10)
  `, [asnId, doNumber, trailerNumber, tractorNumber,
      plateNumber, plateState, shipDate, eta,
      originFacility, destinationFacility]);

  for (const item of items) {
    await db.query(`
      INSERT INTO shipment_lines (asn_id, sku, quantity, expiration_date, lot_number, manufacturer)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [asnId, item.sku, item.quantity, item.expirationDate || null,
        item.lotNumber || null, item.manufacturer || null]);
  }

  // Log it
  await db.query(`
    INSERT INTO edi_log (direction, message_type, do_number, status, control_number, raw_edi)
    VALUES ('outbound', '856', $1, 'sent', $2, $3)
  `, [doNumber, controlNum, edi856]);

  return outFile;
}

module.exports = { generate856 };
