# jobber-token-service

Multi-account Jobber OAuth token refresh service. Manages one refresh token per
sub-entity — each business unit has its own Jobber account but shares a single
Jobber app registration (client_id + client_secret).

Currently used by Crownscape sub-entities. The multi-account pattern works for
any entity that uses Jobber.

## Endpoints

- `GET /token/:subEntity` — Refresh and return access token for a sub-entity
- `GET /token` — Backward compat, uses 'default' account
- `GET /accounts` — List registered sub-entity accounts

## Environment Variables

```
JOBBER_CLIENT_ID=...                    # Shared — one Jobber app registration
JOBBER_CLIENT_SECRET=...                # Shared
JOBBER_REFRESH_TOKEN_WISE_GD=...        # Wise GD Landscaping — ACTIVE
# JOBBER_REFRESH_TOKEN_ICARE=...        # ICARELAWNCARE — stubbed, no token until close (~April 2026)
JOBBER_REFRESH_TOKEN=...                # Optional backward compat (maps to 'default')
```

## Current Accounts

| Sub-Entity | Status | Env Var |
|-----------|--------|---------|
| wise-gd | Active | `JOBBER_REFRESH_TOKEN_WISE_GD` |
| icarelawncare | Pending close (~April 2026) | `JOBBER_REFRESH_TOKEN_ICARE` — not set |

## Adding a New Sub-Entity

1. Obtain the Jobber account's OAuth refresh token
2. Add `JOBBER_REFRESH_TOKEN_{SHORT_NAME}` env var
3. Restart the service
4. Verify: `GET /token/{short-name}`
5. Update sub-entity integrations.json with the credential key
