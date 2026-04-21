const fs = require('fs');
const { X12Parser } = require('node-x12');
const db = require('../db');

async function parse850(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parser = new X12Parser(true);
  const interchange = parser.parse(raw);

  for (const group of interchange.functionalGroups) {
    for (const txn of group.transactions) {

      // BEG segment — order type and DO number
      const beg = txn.segments.find(s => s.tag === 'BEG');
      const orderTypeCodes = { '00': 'new', '05': 'update', '01': 'cancel' };
      const orderType = orderTypeCodes[beg?.valueOf('BEG01')] || 'unknown';
      const doNumber = beg?.valueOf('BEG03');
      const orderDate = beg?.valueOf('BEG05');

      if (!doNumber) {
        console.error('❌ No DO number found in 850');
        continue;
      }

      console.log(`📦 DO: ${doNumber} | Type: ${orderType}`);

      // REF segments
      const refs = txn.segments.filter(s => s.tag === 'REF');
      const fundCite = refs.find(r => r.valueOf('REF01') === 'FG')?.valueOf('REF02');
      const fundDocControl = refs.find(r => r.valueOf('REF01') === '93')?.valueOf('REF02');
      const rrfNumber = refs.find(r => r.valueOf('REF01') === 'W4')?.valueOf('REF02');
      const status = refs.find(r => r.valueOf('REF01') === 'ACC')?.valueOf('REF02');

      // DTM segments
      const dtms = txn.segments.filter(s => s.tag === 'DTM');
      const reqDelivery = dtms.find(d => d.valueOf('DTM01') === '996')?.valueOf('DTM02');
      const latestArrival = dtms.find(d => d.valueOf('DTM01') === '376')?.valueOf('DTM02');

      // N1 party loops
      const n1s = txn.segments.filter(s => s.tag === 'N1');
      const originFacility = n1s.find(n => n.valueOf('N101') === 'OT')?.valueOf('N102');
      const destFacility = n1s.find(n => n.valueOf('N101') === 'DT')?.valueOf('N102');

      // N3/N4 addresses
      const n3s = txn.segments.filter(s => s.tag === 'N3');
      const n4s = txn.segments.filter(s => s.tag === 'N4');
      const originAddress = n3s[0] ? `${n3s[0].valueOf('N301')} ${n3s[0].valueOf('N302') || ''}`.trim() : null;
      const destAddress = n3s[1] ? `${n3s[1].valueOf('N301')} ${n3s[1].valueOf('N302') || ''}`.trim() : null;

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
      const po1s = txn.segments.filter(s => s.tag === 'PO1');
      for (const po1 of po1s) {
        const lineNum = po1.valueOf('PO101');
        const qty = po1.valueOf('PO102');
        const sku = po1.valueOf('PO107');
        const desc = po1.valueOf('PO109');
        const productClass = po1.valueOf('PO111');

        await db.query(`
          INSERT INTO order_lines (do_number, line_number, sku, quantity, description, product_class)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (do_number, line_number) DO UPDATE SET
            quantity = EXCLUDED.quantity,
            description = EXCLUDED.description
        `, [doNumber, lineNum, sku, qty, desc, productClass]);
      }

      // MSG notes
      const msgs = txn.segments.filter(s => s.tag === 'MSG');
      const notes = msgs.map(m => m.valueOf('MSG01')).filter(Boolean).join(' | ');
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
