const test = require('node:test');
const assert = require('node:assert/strict');
const { parse850, generate997, X12Error } = require('../src/services/x12');

const sample850 = [
  'ISA*00*          *00*          *ZZ*521227911      *12*3863629312     *260915*1400*U*00401*000000905*0*T*>',
  'GS*PO*521227911*3863629312*20260915*1400*1*X*004010',
  'ST*850*0001',
  'BEG*00*NE*DO-1001**20260915',
  'REF*FG*FUND-100',
  'REF*W4*RRF-200',
  'DTM*996*20260920',
  'N1*SF*FEMA Warehouse*92*ORIGIN01',
  'N3*100 Supply Road',
  'N4*Atlanta*GA*30301*US',
  'N1*ST*Ray Land Facility*92*DEST01',
  'N3*200 Logistics Way',
  'N4*Branford*FL*32008*US',
  'PO1*1*12*EA*4.50**BP*SKU-001',
  'PID*F****Emergency Supply Kit',
  'CTT*1',
  'SE*15*0001',
  'GE*1*1',
  'IEA*1*000000905',
].join('~') + '~';

test('parses an 850 with party loops and PO1 identifier pairs', () => {
  const result = parse850(sample850);
  assert.equal(result.senderId, '521227911');
  assert.equal(result.receiverId, '3863629312');
  assert.equal(result.transactions.length, 1);
  const order = result.transactions[0];
  assert.equal(order.doNumber, 'DO-1001');
  assert.equal(order.originFacility, 'FEMA Warehouse');
  assert.equal(order.destinationFacility, 'Ray Land Facility');
  assert.equal(order.lines[0].sku, 'SKU-001');
  assert.equal(order.lines[0].description, 'Emergency Supply Kit');
  assert.equal(order.lines[0].quantity, '12');
});

test('generates a correlated 997 and swaps sender and receiver', () => {
  const result = parse850(sample850);
  const ack = generate997(result, result.transactions, 42, true);
  assert.match(ack, /ST\*997\*0042~/);
  assert.match(ack, /AK2\*850\*0001~/);
  assert.match(ack, /AK9\*A\*1\*1\*1~/);
  assert.match(ack, /12\*3863629312/);
  assert.match(ack, /ZZ\*521227911/);
  assert.match(ack, /\*0\*T\*>~/);
});

test('rejects a mismatched transaction control number', () => {
  const broken = sample850.replace('SE*15*0001', 'SE*15*9999');
  assert.throws(() => parse850(broken), error => error instanceof X12Error && error.code === 'TRANSACTION_CONTROL_MISMATCH');
});

test('rejects a mismatched segment count', () => {
  const broken = sample850.replace('SE*15*0001', 'SE*99*0001');
  assert.throws(() => parse850(broken), error => error instanceof X12Error && error.code === 'SEGMENT_COUNT_MISMATCH');
});
