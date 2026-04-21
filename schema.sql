-- BusinessOS EDI Connector — Database Schema
-- Run this against your Railway PostgreSQL instance

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
