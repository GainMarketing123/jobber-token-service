<!-- Project context for Atlas. Persona defined in ~/.claude/CLAUDE.md -->

# Jobber Token Service

## Identity

Multi-account Jobber OAuth token refresh service. One Jobber app registration (shared `client_id` + `client_secret`) fans out to multiple sub-entity refresh tokens; the service returns a fresh access token for the sub-entity named in the request. Primary consumer is Crownscape; the pattern applies to any future entity with Jobber billing.

## Current State

- **Production:** live on Railway at `https://jobber-token-service-production.up.railway.app` (project `genuine-acceptance`, env `production`).
- **Verified 2026-05-12:** `/accounts` returns `{"sub_entities":["wise-gd"],"count":1}` in ~0.28s.
- **Registry:** `status=active`, `staleness_grade=green` as of 2026-05-12.
- **Deploy decision (CEO 2026-05-12, Sprint 1.4):** stays on Railway. Sprint 1.4 corrected `deploy_target` to `railway` rather than migrating a working service. Migration to VPS would be ~3-4 hours of consolidation work — no forcing function exists today.
- **Wise GD:** connected, auto-rotated refresh token persisted back to Railway env on every refresh via the service's `persistTokenToRailway()` logic.
- **ICARELAWNCARE:** stubbed env slot only. No real token until acquisition close (~April 2026).

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js |
| HTTP | Express 4 |
| Fetch | `node-fetch` 2 |
| Auth flow | Jobber OAuth refresh-token grant |
| Token persistence | Railway env vars (auto-write via `persistTokenToRailway`) |
| Tests | `index.test.js` — Node built-in test runner (`node:test`), no extra deps; `npm test` |
| Deploy | Railway |

## Endpoints

- `GET /token/:subEntity` — refresh and return access token for the named sub-entity.
- `GET /token` — backward-compat, maps to the `default` account.
- `GET /accounts` — list registered sub-entity accounts.

## Dependencies

- **Jobber app registration.** One shared `JOBBER_CLIENT_ID` + `JOBBER_CLIENT_SECRET`. App lives in the GPG Jobber developer org.
- **Railway env store.** Source of truth for refresh tokens. Mutating env requires `RAILWAY_API_TOKEN` + project / env / service IDs (`RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`).
- **Wise GD Jobber account.** Live, primary consumer.
- **Future:** ICARELAWNCARE Jobber account at acquisition close.

## Environment variables

All stored in Railway (project `genuine-acceptance`, env `production`). Inspect via `railway link -p genuine-acceptance -e production && railway variables --service jobber-token-service`. **NOT** in laptop `~/.atlas/.env` or VPS `~/.atlas/.env` (corrected 2026-05-12).

| Var | Purpose |
|-----|---------|
| `JOBBER_CLIENT_ID` | shared Jobber app registration |
| `JOBBER_CLIENT_SECRET` | shared |
| `JOBBER_REFRESH_TOKEN_WISE_GD` | Wise GD Landscaping — active, auto-rotated |
| `JOBBER_REFRESH_TOKEN_ICARE` | ICARELAWNCARE — stub until acquisition close |
| `JOBBER_REFRESH_TOKEN` | optional fallback → `default` |
| `RAILWAY_API_TOKEN` | enables auto-rotation persistence path |
| `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` | required by Railway API for env-var writes |

## Key Decisions

1. **One Jobber app, multiple refresh tokens.** Shared `client_id` + `client_secret`; sub-entities differ only in refresh-token slot. Cheaper than separate app registrations and matches Jobber's own multi-account pattern.
2. **Railway over VPS** (CEO 2026-05-12). Railway's native env-var rewrite makes refresh-token persistence trivial; a VPS port would need its own write-back path (env file rewrite or pinned external store). Service works, no forcing function — leave it.
3. **Refresh token persisted back to Railway on every refresh — fail closed.** Each successful OAuth refresh writes the rotated `JOBBER_REFRESH_TOKEN_<SUB>` back to Railway via API. Without this, the service breaks after the first Jobber-side rotation. The write is `await`ed and validated (HTTP status + GraphQL `errors` array): if persistence fails, `GET /token/:subEntity` returns `503` rather than a misleading `200`, so the caller knows the rotated token is not durable. Exception: if `RAILWAY_API_TOKEN` is unset entirely, persistence is intentionally skipped (local-dev config state, not a failure) and the request still succeeds — production MUST have `RAILWAY_API_TOKEN` set.
4. **Sub-entity name is part of the URL** (`GET /token/:subEntity`). Name normalization is the service's responsibility; consumers pass human-readable slugs (`wise-gd`, `icare`).
5. **Single-file service.** `index.js` is the whole thing. Don't fragment it without a real reason.

## Known Issues

- **`JOBBER_REFRESH_TOKEN_ICARE` is a stub** until acquisition close. Until the real token is set, `GET /token/icare` returns an explicit `404` ("sub-entity 'icare' is not registered") — it never reaches the Jobber OAuth call.
- **No automated alert on persistence failure.** Persistence failure is no longer *silent* — `GET /token/:subEntity` now returns `503` and logs the Railway error when the write-back fails. But there is still no proactive monitor: a caller has to actually hit the endpoint to surface the `503`. A health check that exercises the rotation path would close this fully.
- **No retry / backoff** on Jobber's OAuth endpoint. Transient Jobber 5xx is surfaced to the caller as a `502` (was previously a misleading `200`), but there is no automatic retry.

## What would make me worry

1. **Refresh-token persistence regression on Wise GD.** This is the live production critical path for Crownscape. If `persistTokenToRailway()` 5xxs (Railway API rate limit, expired `RAILWAY_API_TOKEN`, wrong service ID after a Railway-side rename), the rotated token is not written back. As of Sprint 1.6 this is no longer *silent* — the request fails closed with a `503` and logs the Railway error — but it is still reactive: the failure only surfaces when a caller hits the endpoint. A health check that actively exercises the rotation path (not just `/accounts`) would turn this from reactive into proactive.
2. **ICARELAWNCARE first-day failure post-acquisition-close.** The ICARE slot has never seen a real refresh token. The first day post-close we drop in the real token and start serving requests. Any sub-entity-specific bug (slug normalization, env-var name mismatch, Jobber-account-specific scope) shows up in production on a brand-new operation with no fallback. Worth a dry-run with a throwaway Jobber sandbox account before close.

## When picking this up

1. Verify service is up: `curl https://jobber-token-service-production.up.railway.app/accounts` (expect HTTP 200, `{"sub_entities":["wise-gd"],"count":1}`).
2. Inspect or update env vars: `railway link -p genuine-acceptance -e production` then `railway variables --service jobber-token-service`. Refresh-token rotation writes back automatically.
3. **If a forcing function appears** (Atlas governance gap, Railway pricing change, third-party-dependency reduction push), migration to VPS is ~3-4 hrs: extract `JOBBER_*` + `RAILWAY_*` env vars, replicate to VPS `~/.atlas/.env`, deploy systemd unit using `wisestream-proxy.service` as the sibling pattern, switch consumer endpoints from Railway URL to VPS URL, decide on refresh-token persistence target (VPS env file rewrite vs. keep writing to Railway as a backing store).
4. Run the test suite: `npm test` (runs `index.test.js` via Node's built-in test runner — covers the 502-on-Jobber-rejection and 503-on-persistence-failure paths). `npm install` first if `node_modules/` is absent.
