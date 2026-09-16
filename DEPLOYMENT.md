# Railway production rollout

This rollout is deliberately staged. Do not merge the three `revamp/edi-v2`
pull requests until the variables below are configured: merging may trigger the
current Railway services to deploy immediately.

## 1. Confirm the GEX details that code cannot decide

Before production traffic is enabled, obtain written confirmation of:

- the authentication method and header for inbound HTTPS messages;
- GEX test and production source IP addresses;
- the URL and authentication GEX expects Ray Land to use for returning 997s;
- the approved X12 versions and FEMA implementation guide for 850 and 997;
- Ray Land's receiver identifiers and FEMA/GEX sender identifiers in test and
  production;
- whether 856 is in scope and, if so, its mapping and testing requirements.

Keep `OUTBOUND_MODE=manual` and `ENABLE_856=false` until those answers are
approved. A queued 997 is not the same as a delivered 997.

## 2. Configure the connector service

Attach a Railway PostgreSQL service and set these variables on the connector:

```dotenv
NODE_ENV=production
PORT=3000
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=disable
DATABASE_SSL_REJECT_UNAUTHORIZED=true
TRUST_PROXY=1

ADMIN_PASSWORD=<long unique password>
SESSION_SECRET=<at least 32 random bytes>
SESSION_HOURS=8
CORS_ORIGINS=https://boss-edi-frontend-production.up.railway.app

GEX_INBOUND_TOKEN=<test credential agreed with GEX>
GEX_INBOUND_TOKEN_HEADER=x-edi-token
GEX_ALLOWED_IPS=
EDI_MAX_BYTES=2097152

OUTBOUND_MODE=manual
GEX_OUTBOUND_URL=
GEX_OUTBOUND_TOKEN=
GEX_OUTBOUND_TOKEN_HEADER=authorization
GEX_OUTBOUND_TOKEN_SCHEME=Bearer
OUTBOUND_TIMEOUT_MS=30000
OUTBOUND_POLL_MS=15000
OUTBOUND_MAX_ATTEMPTS=8

EDI_COMPANY_NAME=Ray Land Inc. DBA Land Logistics
RAY_ISA_ID=3863629312
RAY_ISA_QUALIFIER=12
ENABLE_856=false
```

Use a Railway reference variable for `DATABASE_URL`; never paste database or
GEX credentials into Git. During the initial deployment, `/` can be used as the
Railway liveness path. Once all variables and PostgreSQL are working, use
`/edi/health` as the readiness health check. It must return HTTP 200 and
`"ready": true`.

If GEX approves a different token header or an IP allowlist, update the matching
variables before sending test traffic. Exact IP matching is supported; CIDR
ranges are not.

## 3. Configure the frontend service

The API URL is required at both build time and runtime:

```dotenv
VITE_API_URL=https://boss-edi-connector-production.up.railway.app
API_ORIGIN=https://boss-edi-connector-production.up.railway.app
PORT=3001
```

`VITE_API_URL` tells the browser where to call the API. `API_ORIGIN` limits the
production Content Security Policy to that API origin.

## 4. Retire the old AS2 service

GEX stated that it pushes through HTTPS on port 443. The OpenAS2 replacement is
therefore a tombstone service: it returns HTTP 410 and never sends a false MDN.
Keep the old AS2 Railway service paused or deploy the tombstone only if callers
need an explicit retirement response.

## 5. Deploy and verify in this order

1. Configure PostgreSQL and all connector variables.
2. Merge and deploy the connector pull request.
3. Confirm `/edi/health` reports ready and review startup logs for migration or
   database errors.
4. Configure the frontend variables, then merge and deploy its pull request.
5. Log in to the dashboard and confirm Overview, Orders, EDI activity, and
   System load without browser errors.
6. With GEX or an authorized tester, send one controlled test 850 using the
   approved test credential. Confirm one inbound message, one order, and one
   queued 997. Resend the identical payload and confirm it is marked duplicate,
   not imported twice.
7. After GEX supplies and approves the return endpoint, set the outbound URL and
   credential, change `OUTBOUND_MODE=http`, redeploy, and verify the 997 becomes
   `delivered` only after a successful HTTP response.
8. Complete the GEX test evidence, firewall checks, agreement updates, and IDG
   before enabling production traffic.

## 6. Acceptance checklist

- [ ] Connector health is ready and PostgreSQL backups/retention are enabled.
- [ ] Dashboard login works; an unauthenticated API call is rejected.
- [ ] An inbound call without the GEX credential is rejected.
- [ ] A valid test 850 imports once and generates a structurally valid 997.
- [ ] Duplicate delivery does not create a second order.
- [ ] Malformed X12 is retained as rejected with a useful error.
- [ ] GEX confirms the return 997 was received and correlated.
- [ ] Test and production credentials are different and stored only in Railway.
- [ ] `GEX_ALLOWED_IPS` is populated after GEX supplies authoritative addresses.
- [ ] 856 remains disabled unless separately mapped, tested, and approved.

## Rollback

If a deployment fails, redeploy the previous successful Railway deployment.
The schema migration is additive, so the earlier application can continue to
use its existing tables. Do not delete the new audit tables or raw messages
during rollback.
