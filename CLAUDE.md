<!-- Project context for Atlas. Persona defined in ~/.claude/CLAUDE.md -->

# Jobber Token Service

## Overview

Multi-account Jobber OAuth token refresh service. One Jobber app registration (shared `client_id` + `client_secret`) fans out to multiple sub-entity refresh tokens; the service returns a fresh access token for the sub-entity named in the request. Primary consumer is Crownscape; the pattern applies to any entity with Jobber billing.

## Status

- **Code:** tracked at `GainMarketing123/jobber-token-service`; laptop copy at `/home/thao/projects/crownscape/jobber-token-service`.
- **Runtime:** **ACTIVE on Railway** at `https://jobber-token-service-production.up.railway.app` (Railway project `genuine-acceptance`, environment `production`). Verified 2026-05-12 via HTTP probe — `/accounts` returns `{"sub_entities":["wise-gd"],"count":1}` in ~0.28s. Registry `status=active`, `staleness_grade=green` as of 2026-05-12.
- **Deploy decision (CEO 2026-05-12, Sprint 1.4):** stays on Railway. The earlier registry `deploy_target=vps` was a strategic-intent mismatch with the actual deployment; Sprint 1.4 corrected `deploy_target` to `railway` rather than migrating a working service. Rationale: service works, refresh-token persistence is Railway-native, migration is consolidation work without a forcing function.
- **Ownership:** Crownscape entity (Wise GD Landscaping + future Crownscape LLC post-acquisition).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js |
| HTTP | Express 4 |
| Fetch | node-fetch 2 |

## Endpoints

- `GET /token/:subEntity` — refresh and return access token for the named sub-entity
- `GET /token` — backward-compat, maps to the `default` account
- `GET /accounts` — list registered sub-entity accounts

## Environment variables

**Stored in Railway** (project `genuine-acceptance`, environment `production`). Inspect via `railway link -p genuine-acceptance -e production && railway variables --service jobber-token-service`. NOT in laptop `~/.atlas/.env` or VPS `~/.atlas/.env` (corrected 2026-05-12).

- `JOBBER_CLIENT_ID` — shared Jobber app registration
- `JOBBER_CLIENT_SECRET` — shared
- `JOBBER_REFRESH_TOKEN_WISE_GD` — Wise GD Landscaping (active; auto-rotated and persisted back to Railway env on every refresh via the service's `persistTokenToRailway()` logic)
- `JOBBER_REFRESH_TOKEN_ICARE` — ICARELAWNCARE (stubbed, no real token until acquisition close ~April 2026)
- `JOBBER_REFRESH_TOKEN` — optional fallback, mapped to `default`
- `RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` — required for the auto-rotation persistence path

## Commands

- `npm start` — run the service (`node index.js`)
- `npm install` — install deps

## Key files

- `index.js` — single-file service
- `package.json` — deps

## When picking this up

1. Service is on Railway, not VPS — verify it's up via `curl https://jobber-token-service-production.up.railway.app/accounts` (expect HTTP 200, `{"sub_entities":["wise-gd"],"count":1}`).
2. To inspect/update env vars: `railway link -p genuine-acceptance -e production` then `railway variables --service jobber-token-service`. Refresh-token rotation persists back to Railway env automatically.
3. If a migration to VPS becomes warranted (consolidation, Atlas governance coverage, cost), it's ~3-4 hrs: extract JOBBER_* + RAILWAY_* env vars, replicate to VPS `~/.atlas/.env`, deploy systemd unit using `wisestream-proxy.service` as the sibling pattern, switch consumer endpoints from Railway URL to VPS URL, decide on refresh-token persistence target (VPS env file rewrite vs. keep writing to Railway as a backing store).
4. Token refresh tests live in the same directory.
