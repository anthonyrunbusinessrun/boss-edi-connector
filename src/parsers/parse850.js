const fs = require('fs');
const { X12Parser } = require('node-x12');
const db = require('../db');

async function parse850(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parser = new X12Parser();
  const interchange = parser.parse(raw);

  for (const group of interchange.functionalGroups) {
    for (const txn of group.transactions) {

      const segments = txn.segments;

      // Helper to find segment and get element value
      const findSeg = (tag) => segments.find(s => s.tag === tag);
      const findSegs = (tag) => segments.filter(s => s.tag === tag);
      const getVal = (seg, idx) => seg && seg.elements && seg.elements[idx - 1] ? seg.elements[idx - 1].value : null;

      // BEG segment
      const beg = findSeg('BEG');
      const orderTypeCodes = { '00': 'new', '05': 'update', '01': 'cancel' };
      const orderType = orderTypeCodes[getVal(beg, 1)] || 'unknown';
      const doNumber = getVal(beg, 3);

      if (!doNumber) {
        console.error('❌ No DO number found in 850');
        continue;
      }

      console.log(`📦 DO: ${doNumber} | Type: ${orderType}`);

      // REF segments
      const refs = findSegs('REF');
      const getRef = (qualifier) => {
        const seg = refs.find(r => getVal(r, 1) === qualifier);
        return getVal(seg, 2);
      };
      const fundCite = getRef('FG');
      const fundDocControl = getRef('93');
      const rrfNumber = getRef('W4');
      const status = getRef('ACC');

      // DTM segments
      const dtms = findSegs('DTM');
      const getDtm = (qualifier) => {
        const seg = dtms.find(d => getVal(d, 1) === qualifier);
        return getVal(seg, 2);
      };
      const reqDelivery = getDtm('996');
      const latestArrival = getDtm('376');

      // N1 party loops
      const n1s = findSegs('N1');
      const getN1 = (qualifier) => {
        const seg = n1s.find(n => getVal(n, 1) === qualifier);
        return getVal(seg, 2);
      };
      const originFacility = getN1('OT');
      const destFacility = getN1('DT');

      // N3 address lines
      const n3s = findSegs('N3');
      const originAddress = n3s[0] ? getVal(n3s[0], 1) : null;
      const destAddress = n3s[1] ? getVal(n3s[1], 1) : null;

      // Upsert order
      await db.query(`
        INSERT INTO orders (
          do_number, order_type, status, fund_cite, fund_doc_control,
          rrf_number, requested_delivery, latest_arrival,
          origin_facility, origin_address, destination_facility, destination_address
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (do_number) DO UPDATE SET
          order_type = EXCLUDED.order_type,
          status = EXCLUDED.status,
          requested_delivery = EXCLUDED.requested_delivery,
          latest_arrival = EXCLUDED.latest_arrival,
          destination_facility = EXCLUDED.destination_facility,
          destination_address = EXCLUDED.destination_address,
          updated_at = NOW()
      `, [doNumber, orderType, status, fundCite, fundDocControl,
          rrfNumber, reqDelivery, latestArrival,
          originFacility, originAddress, destFacility, destAddress]);

      // PO1 line items
      const po1s = findSegs('PO1');
      for (const po1 of po1s) {
        const lineNum = getVal(po1, 1);
        const qty = getVal(po1, 2);
        const sku = getVal(po1, 7);
        const desc = getVal(po1, 9);
        const productClass = getVal(po1, 11);

        await db.query(`
          INSERT INTO order_lines (do_number, line_number, sku, quantity, description, product_class)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (do_number, line_number) DO UPDATE SET
            quantity = EXCLUDED.quantity,
            description = EXCLUDED.description
        `, [doNumber, lineNum, sku, qty, desc, productClass]);
      }

      // MSG notes
      const msgs = findSegs('MSG');
      const notes = msgs.map(m => getVal(m, 1)).filter(Boolean).join(' | ');
      if (notes) {
        await db.query(`UPDATE orders SET notes = $1 WHERE do_number = $2`, [notes, doNumber]);
      }

      // Log it
      await db.query(`
        INSERT INTO edi_log (direction, message_type, do_number, status, raw_edi)
        VALUES ('inbound', '850', $1, 'received', $2)
      `, [doNumber, raw]);

      console.log(`✅ Order saved: ${doNumber} (${orderType}) — ${po1s.length} line items`);
    }
  }
}

module.exports = { parse850 };
