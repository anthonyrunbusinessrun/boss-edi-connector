const crypto = require('crypto');

function list(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const config = {
  nodeEnv,
  isProduction,
  port: number(process.env.PORT, 3000),
  trustProxy: process.env.TRUST_PROXY === 'false' ? false : number(process.env.TRUST_PROXY, 1),
  corsOrigins: list(process.env.CORS_ORIGINS),
  admin: {
    password: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    sessionHours: number(process.env.SESSION_HOURS, 8),
  },
  inbound: {
    token: process.env.GEX_INBOUND_TOKEN || '',
    tokenHeader: String(process.env.GEX_INBOUND_TOKEN_HEADER || 'x-edi-token').toLowerCase(),
    allowedIps: list(process.env.GEX_ALLOWED_IPS),
    maxBytes: number(process.env.EDI_MAX_BYTES, 2 * 1024 * 1024),
  },
  outbound: {
    mode: process.env.OUTBOUND_MODE || 'manual',
    url: process.env.GEX_OUTBOUND_URL || '',
    token: process.env.GEX_OUTBOUND_TOKEN || '',
    tokenHeader: String(process.env.GEX_OUTBOUND_TOKEN_HEADER || 'authorization').toLowerCase(),
    tokenScheme: process.env.GEX_OUTBOUND_TOKEN_SCHEME || 'Bearer',
    timeoutMs: number(process.env.OUTBOUND_TIMEOUT_MS, 30000),
    pollMs: number(process.env.OUTBOUND_POLL_MS, 15000),
    maxAttempts: number(process.env.OUTBOUND_MAX_ATTEMPTS, 8),
  },
  edi: {
    companyName: process.env.EDI_COMPANY_NAME || 'Ray Land Inc. DBA Land Logistics',
    rayIsaId: process.env.RAY_ISA_ID || '3863629312',
    rayIsaQualifier: process.env.RAY_ISA_QUALIFIER || '12',
    enable856: process.env.ENABLE_856 === 'true',
  },
};

config.readinessIssues = () => {
  const issues = [];
  if (!process.env.DATABASE_URL) issues.push('DATABASE_URL is not configured');
  if (!config.admin.password) issues.push('ADMIN_PASSWORD is not configured');
  if (!process.env.SESSION_SECRET) issues.push('SESSION_SECRET is not configured');
  if (config.isProduction && !config.corsOrigins.length) issues.push('CORS_ORIGINS is not configured');
  if (config.isProduction && !config.inbound.token) issues.push('GEX_INBOUND_TOKEN is not configured');
  if (config.outbound.mode === 'http' && !config.outbound.url) issues.push('GEX_OUTBOUND_URL is required for HTTP delivery');
  if (!['manual', 'http'].includes(config.outbound.mode)) issues.push('OUTBOUND_MODE must be manual or http');
  return issues;
};

module.exports = config;
