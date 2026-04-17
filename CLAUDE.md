<!-- Project context for Atlas. Persona defined in ~/.claude/CLAUDE.md -->

# Jobber Token Service

## Overview

Multi-account Jobber OAuth token refresh service. One Jobber app registration (shared `client_id` + `client_secret`) fans out to multiple sub-entity refresh tokens; the service returns a fresh access token for the sub-entity named in the request. Primary consumer is Crownscape; the pattern applies to any entity with Jobber billing.

## Status

- **Code:** tracked at `GainMarketing123/jobber-token-service`; laptop copy at `/home/thao/projects/crownscape/jobber-token-service`.
- **Runtime:** registry `status=unknown` as of 2026-04-16. No matching systemd service was found during the Phase 1 item 1.7 VPS audit — see `proof.evidence_summary` in `~/.atlas-operations/project-registry.json`.
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

Stored in `~/.atlas/.env` on both laptop and VPS:

- `JOBBER_CLIENT_ID` — shared Jobber app registration
- `JOBBER_CLIENT_SECRET` — shared
- `JOBBER_REFRESH_TOKEN_WISE_GD` — Wise GD Landscaping (active)
- `JOBBER_REFRESH_TOKEN_ICARE` — ICARELAWNCARE (stubbed, no real token until acquisition close ~April 2026)
- `JOBBER_REFRESH_TOKEN` — optional fallback, mapped to `default`

## Commands

- `npm start` — run the service (`node index.js`)
- `npm install` — install deps

## Key files

- `index.js` — single-file service
- `package.json` — deps

## When picking this up

1. Do not assume it is running on VPS — confirm via `systemctl status` or the proof fields in the registry before writing behavior that depends on it.
2. If reactivating on VPS, add a systemd unit alongside similar services. `~/.atlas-operations/templates/atlas-bridge.service` is the closest precedent, and `wisestream-proxy.service` is a working sibling pattern.
3. Token refresh tests live in the same directory.
