# Ray Land BusinessOS EDI Gateway

Production-oriented HTTPS EDI gateway for the Ray Land / FEMA / DAAS GEX
connection. GEX told Ray Land it can push only over HTTPS on port 443, so AS2
is intentionally not part of this service.

## Supported scope

- Authenticated HTTPS receipt of X12 850 purchase orders
- Envelope and transaction-control validation
- SHA-256 duplicate detection
- PostgreSQL-backed orders, lines, raw messages, and audit state
- X12 997 generation with unique outbound control numbers
- Durable outbound queue with retries and truthful delivery states
- Minimal authenticated API for the BusinessOS dashboard
- 856 dispatch disabled until FEMA/GEX confirms scope and mapping

This service is an implementation foundation, not evidence of GEX approval.
Production activation still requires the agreement, final implementation guide,
authentication details, test evidence, firewall validation, and GEX authorization.

## Local setup

1. Create PostgreSQL and copy `.env.example` to `.env`.
2. Set `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and
   `GEX_INBOUND_TOKEN`.
3. Run `npm install`, `npm test`, then `npm start`.

The additive schema in `schema.sql` runs automatically at startup.

## Endpoints

- `GET /edi/health` - service and readiness state
- `POST /edi/inbound` - GEX X12 payload; protected by the configured inbound token
- `POST /api/auth/login` - dashboard login
- `GET /api/dashboard` - counts, connection state, recent messages
- `GET /api/orders` and `GET /api/orders/:doNumber`
- `GET /api/messages` and `POST /api/messages/:id/retry`

## Outbound modes

- `manual` (default): 997s remain queued until GEX supplies its approved return
  route. The UI says queued; it never says sent.
- `http`: posts queued 997s to `GEX_OUTBOUND_URL`, retries transient failures,
  and marks a message delivered only after an HTTP 2xx response.

## Security notes

- Do not put `ADMIN_PASSWORD`, `SESSION_SECRET`, or GEX credentials in Git.
- Restrict `CORS_ORIGINS` to the deployed frontend.
- Configure `GEX_ALLOWED_IPS` after GEX provides test and production addresses.
- Rotate credentials separately for test and production.
- Raw EDI is retained for audit; configure database backup and retention before
  production.
