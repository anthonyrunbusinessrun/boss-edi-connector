const crypto = require('crypto');

class X12Error extends Error {
  constructor(message, code = 'INVALID_X12') {
    super(message);
    this.name = 'X12Error';
    this.code = code;
    this.status = 422;
  }
}

function normalize(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new X12Error('EDI payload is empty', 'EMPTY_PAYLOAD');
  return raw.replace(/^\uFEFF/, '').trim();
}

function parseSegments(rawInput) {
  const raw = normalize(rawInput);
  const elementSeparator = raw.startsWith('ISA') && raw.length > 3 ? raw[3] : '*';
  let segmentTerminator = '~';
  if (raw.startsWith('ISA') && raw.length > 105) segmentTerminator = raw[105];
  if (!raw.includes(segmentTerminator)) segmentTerminator = raw.includes('~') ? '~' : '\n';
  const segments = raw
    .split(segmentTerminator)
    .map(segment => segment.replace(/[\r\n]+/g, '').trim())
    .filter(Boolean)
    .map(segment => segment.split(elementSeparator));
  if (!segments.length) throw new X12Error('No X12 segments were found');
  return { raw, segments, elementSeparator, segmentTerminator };
}

function value(segment, index) {
  const result = segment?.[index];
  return result === undefined || result === '' ? null : String(result).trim();
}

function requireSegment(segments, tag) {
  const segment = segments.find(item => item[0] === tag);
  if (!segment) throw new X12Error(`Required ${tag} segment is missing`, `MISSING_${tag}`);
  return segment;
}

function validateEnvelope(segments) {
  if (segments.filter(item => item[0] === 'GS').length !== 1) {
    throw new X12Error('Exactly one functional group per payload is currently supported', 'UNSUPPORTED_GROUP_COUNT');
  }
  const isa = requireSegment(segments, 'ISA');
  const gs = requireSegment(segments, 'GS');
  const ge = requireSegment(segments, 'GE');
  const iea = requireSegment(segments, 'IEA');
  if (value(isa, 13) && value(iea, 2) && value(isa, 13) !== value(iea, 2)) {
    throw new X12Error('ISA13 and IEA02 control numbers do not match', 'CONTROL_NUMBER_MISMATCH');
  }
  if (value(gs, 6) && value(ge, 2) && value(gs, 6) !== value(ge, 2)) {
    throw new X12Error('GS06 and GE02 control numbers do not match', 'GROUP_CONTROL_MISMATCH');
  }
  return { isa, gs };
}

function transactionSets(segments) {
  const sets = [];
  let current = null;
  for (const segment of segments) {
    if (segment[0] === 'ST') current = [segment];
    else if (current) current.push(segment);
    if (segment[0] === 'SE' && current) {
      sets.push(current);
      current = null;
    }
  }
  if (!sets.length) throw new X12Error('No complete ST/SE transaction set was found', 'MISSING_TRANSACTION_SET');
  return sets;
}

function validateTransaction(segments) {
  const st = requireSegment(segments, 'ST');
  const se = requireSegment(segments, 'SE');
  if (value(st, 2) && value(se, 2) && value(st, 2) !== value(se, 2)) {
    throw new X12Error('ST02 and SE02 control numbers do not match', 'TRANSACTION_CONTROL_MISMATCH');
  }
  const declared = Number(value(se, 1));
  if (Number.isFinite(declared) && declared !== segments.length) {
    throw new X12Error(`SE01 declares ${declared} segments but ${segments.length} were received`, 'SEGMENT_COUNT_MISMATCH');
  }
  return st;
}

function formatAddress(party) {
  if (!party) return null;
  return [party.address1, party.address2, [party.city, party.state, party.postal].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ') || null;
}

function parse850(rawInput) {
  const parsed = parseSegments(rawInput);
  const { isa, gs } = validateEnvelope(parsed.segments);
  const transactions = [];

  for (const txn of transactionSets(parsed.segments)) {
    const st = validateTransaction(txn);
    if (value(st, 1) !== '850') continue;
    const beg = requireSegment(txn, 'BEG');
    const doNumber = value(beg, 3);
    if (!doNumber) throw new X12Error('BEG03 purchase order number is missing', 'MISSING_ORDER_NUMBER');

    const refs = {};
    const dates = {};
    const parties = {};
    const lines = [];
    const notes = [];
    let party = null;
    let line = null;

    for (const segment of txn) {
      const tag = segment[0];
      if (tag === 'REF' && value(segment, 1)) refs[value(segment, 1)] = value(segment, 2);
      if (tag === 'DTM' && value(segment, 1)) dates[value(segment, 1)] = value(segment, 2);
      if (tag === 'MSG' && value(segment, 1)) notes.push(value(segment, 1));
      if (tag === 'N1') {
        party = { qualifier: value(segment, 1), name: value(segment, 2), idQualifier: value(segment, 3), id: value(segment, 4) };
        if (party.qualifier) parties[party.qualifier] = party;
      } else if (tag === 'N3' && party) {
        party.address1 = value(segment, 1);
        party.address2 = value(segment, 2);
      } else if (tag === 'N4' && party) {
        party.city = value(segment, 1);
        party.state = value(segment, 2);
        party.postal = value(segment, 3);
        party.country = value(segment, 4);
      } else if (tag === 'PO1') {
        const identifiers = {};
        for (let i = 6; i < segment.length; i += 2) {
          if (value(segment, i) && value(segment, i + 1)) identifiers[value(segment, i)] = value(segment, i + 1);
        }
        line = {
          lineNumber: value(segment, 1) || String(lines.length + 1),
          quantity: value(segment, 2),
          unit: value(segment, 3) || 'UN',
          unitPrice: value(segment, 4),
          identifiers,
          sku: identifiers.BP || identifiers.SK || identifiers.VN || identifiers.UP || identifiers.MG || Object.values(identifiers)[0] || null,
          description: null,
        };
        lines.push(line);
      } else if (tag === 'PID' && line && value(segment, 5)) {
        line.description = value(segment, 5);
      }
    }

    const origin = parties.SF || parties.OT || parties.SE || null;
    const destination = parties.ST || parties.DT || null;
    transactions.push({
      doNumber,
      orderType: ({ '00': 'new', '01': 'cancel', '05': 'update' })[value(beg, 1)] || 'unknown',
      status: refs.ACC || null,
      fundCite: refs.FG || null,
      fundDocControl: refs['93'] || null,
      rrfNumber: refs.W4 || null,
      requestedDelivery: dates['996'] || dates['002'] || null,
      latestArrival: dates['376'] || null,
      originFacility: origin?.name || origin?.id || null,
      originAddress: formatAddress(origin),
      destinationFacility: destination?.name || destination?.id || null,
      destinationAddress: formatAddress(destination),
      notes: notes.join(' | ') || null,
      lines,
      transactionControl: value(st, 2),
    });
  }

  if (!transactions.length) throw new X12Error('The interchange does not contain an 850 transaction', 'UNSUPPORTED_TRANSACTION');
  return {
    raw: parsed.raw,
    messageHash: crypto.createHash('sha256').update(parsed.raw).digest('hex'),
    senderQualifier: value(isa, 5),
    senderId: value(isa, 6),
    receiverQualifier: value(isa, 7),
    receiverId: value(isa, 8),
    interchangeVersion: value(isa, 12) || '00401',
    interchangeControl: value(isa, 13),
    usageIndicator: value(isa, 15) || 'T',
    functionalId: value(gs, 1),
    groupSenderId: value(gs, 2),
    groupReceiverId: value(gs, 3),
    groupControl: value(gs, 6),
    version: value(gs, 8) || '004010',
    transactions,
  };
}

function pad(value, length) {
  return String(value || '').slice(0, length).padEnd(length, ' ');
}

function controls(now, control) {
  const iso = now.toISOString();
  return {
    shortDate: iso.slice(2, 10).replace(/-/g, ''),
    fullDate: iso.slice(0, 10).replace(/-/g, ''),
    time: iso.slice(11, 16).replace(':', ''),
    isa: String(control).padStart(9, '0').slice(-9),
    group: String(Number(control)),
    transaction: String(Number(control)).padStart(4, '0'),
  };
}

function generate997(inbound, transactionsInput, control, accepted = true) {
  const c = controls(new Date(), control);
  const ackCode = accepted ? 'A' : 'R';
  const transactions = Array.isArray(transactionsInput) ? transactionsInput : [transactionsInput];
  const senderId = inbound.receiverId;
  const receiverId = inbound.senderId;
  const senderQualifier = inbound.receiverQualifier || '12';
  const receiverQualifier = inbound.senderQualifier || 'ZZ';
  const transactionAcks = transactions.flatMap(transaction => [
    `AK2*850*${transaction.transactionControl}`,
    `AK5*${ackCode}`,
  ]);
  const included = accepted ? transactions.length : 0;
  const segments = [
    `ISA*00*          *00*          *${senderQualifier}*${pad(senderId, 15)}*${receiverQualifier}*${pad(receiverId, 15)}*${c.shortDate}*${c.time}*U*${inbound.interchangeVersion || '00401'}*${c.isa}*0*${inbound.usageIndicator || 'T'}*>`,
    `GS*FA*${inbound.groupReceiverId || senderId}*${inbound.groupSenderId || receiverId}*${c.fullDate}*${c.time}*${c.group}*X*${inbound.version || '004010'}`,
    `ST*997*${c.transaction}`,
    `AK1*${inbound.functionalId || 'PO'}*${inbound.groupControl}`,
    ...transactionAcks,
    `AK9*${ackCode}*${transactions.length}*${transactions.length}*${included}`,
    `SE*${4 + (transactions.length * 2)}*${c.transaction}`,
    `GE*1*${c.group}`,
    `IEA*1*${c.isa}`,
  ];
  return `${segments.join('~\n')}~`;
}

module.exports = { X12Error, parseSegments, parse850, generate997 };
