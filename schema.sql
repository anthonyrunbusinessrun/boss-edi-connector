-- BusinessOS EDI Gateway v2 - additive schema safe for existing Railway data.

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  do_number VARCHAR(50) UNIQUE NOT NULL,
  order_type VARCHAR(20),
  status VARCHAR(50),
  fund_cite VARCHAR(100),
  fund_doc_control VARCHAR(100),
  rrf_number VARCHAR(100),
  requested_delivery VARCHAR(20),
  latest_arrival VARCHAR(20),
  origin_facility VARCHAR(100),
  origin_address TEXT,
  destination_facility VARCHAR(100),
  destination_address TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_lines (
  id SERIAL PRIMARY KEY,
  do_number VARCHAR(50) REFERENCES orders(do_number),
  line_number VARCHAR(10),
  sku VARCHAR(100),
  description TEXT,
  product_class VARCHAR(100),
  quantity DECIMAL,
  unit VARCHAR(10) DEFAULT 'UN',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(do_number, line_number)
);

CREATE TABLE IF NOT EXISTS shipments (
  id SERIAL PRIMARY KEY,
  asn_id VARCHAR(100) UNIQUE NOT NULL,
  do_number VARCHAR(50) REFERENCES orders(do_number),
  status VARCHAR(50),
  trailer_number VARCHAR(100),
  tractor_number VARCHAR(100),
  plate_number VARCHAR(50),
  plate_state VARCHAR(10),
  ship_date VARCHAR(20),
  eta VARCHAR(20),
  origin_facility VARCHAR(100),
  destination_facility VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipment_lines (
  id SERIAL PRIMARY KEY,
  asn_id VARCHAR(100) REFERENCES shipments(asn_id),
  sku VARCHAR(100),
  quantity DECIMAL,
  unit VARCHAR(10) DEFAULT 'UN',
  expiration_date VARCHAR(20),
  lot_number VARCHAR(100),
  manufacturer VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  sku VARCHAR(100) PRIMARY KEY,
  description TEXT,
  unit VARCHAR(10) DEFAULT 'UN',
  on_hand DECIMAL NOT NULL DEFAULT 0,
  allocated DECIMAL NOT NULL DEFAULT 0,
  reorder_point DECIMAL NOT NULL DEFAULT 0,
  location VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS edi_log (
  id SERIAL PRIMARY KEY,
  direction VARCHAR(10),
  message_type VARCHAR(10),
  control_number VARCHAR(50),
  do_number VARCHAR(50),
  status VARCHAR(20),
  raw_edi TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS edi_messages (
  id BIGSERIAL PRIMARY KEY,
  message_hash CHAR(64) NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type VARCHAR(10) NOT NULL,
  status VARCHAR(24) NOT NULL,
  filename VARCHAR(255),
  partner VARCHAR(100),
  correlation_id VARCHAR(100),
  related_message_id BIGINT REFERENCES edi_messages(id),
  interchange_control VARCHAR(50),
  group_control VARCHAR(50),
  transaction_control VARCHAR(50),
  do_number VARCHAR(50),
  raw_edi TEXT NOT NULL,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  http_status INTEGER,
  response_excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(direction, message_hash)
);

CREATE SEQUENCE IF NOT EXISTS edi_control_number_seq START 1;

CREATE INDEX IF NOT EXISTS idx_edi_messages_status_created
  ON edi_messages(direction, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edi_messages_do_number
  ON edi_messages(do_number);
CREATE INDEX IF NOT EXISTS idx_edi_messages_retry
  ON edi_messages(direction, status, next_attempt_at)
  WHERE direction = 'outbound';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_message_id BIGINT REFERENCES edi_messages(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_id VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_id VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS bol_number VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_shipments_status_created
  ON shipments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_sku
  ON shipment_lines(sku);
