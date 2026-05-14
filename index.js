const express = require('express');
const app = express();

// `fetch` is held in a mutable module-level slot so the test suite can inject a
// stub without a network round-trip. Production uses node-fetch unchanged.
let fetch = require('node-fetch');
function setFetch(fn) { fetch = fn; }

// Multi-account token storage — one refresh token per sub-entity.
// Each sub-entity (across any brand umbrella) has its own Jobber account
// but shares the same app credentials (client_id + client_secret).
const refreshTokens = {};

// Sub-entities whose in-memory refresh token is NEWER than what Railway holds.
// Jobber's refresh tokens are single-use and rotate on every refresh: once a
// refresh succeeds, the OLD token may already be revoked, so the NEW token is
// the only valid one and MUST be kept in memory even when the Railway write-back
// fails. Discarding it would turn a transient Railway blip into a hard
// invalid_grant outage. This set records "the in-memory token works but is not
// durable across a restart" so the gap is visible (in the /token response and
// /accounts) instead of silent. An entry is cleared once persistence succeeds.
const nonDurableTokens = new Set();

// Persist a rotated refresh token back to Railway env vars so it survives restarts.
// Without this, Jobber's token rotation means the env var goes stale after first use.
//
// Fails CLOSED: callers MUST await this and treat a thrown error as a hard failure.
// A silently-dropped persistence means the next refresh uses a stale token and the
// sub-entity's Jobber integration goes down with no early warning (Worry #1 in CLAUDE.md).
class TokenPersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenPersistenceError';
  }
}

async function persistTokenToRailway(subEntity, newToken) {
  const apiToken = process.env.RAILWAY_API_TOKEN;
  if (!apiToken) {
    // No Railway API token configured — persistence is intentionally disabled
    // (e.g. local dev). This is a deliberate config state, not a failure, so we
    // skip rather than throw. Production MUST have RAILWAY_API_TOKEN set.
    console.warn(`RAILWAY_API_TOKEN not set — skipping token persistence for ${subEntity}`);
    return;
  }

  // Convert sub-entity name back to env var format (wise-gd → WISE_GD)
  const envSuffix = subEntity.toUpperCase().replace(/-/g, '_');
  const envName = subEntity === 'default'
    ? 'JOBBER_REFRESH_TOKEN'
    : `JOBBER_REFRESH_TOKEN_${envSuffix}`;

  let response;
  try {
    response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        query: `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        variables: {
          input: {
            projectId: process.env.RAILWAY_PROJECT_ID,
            environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
            serviceId: process.env.RAILWAY_SERVICE_ID,
            name: envName,
            value: newToken
          }
        }
      })
    });
  } catch (err) {
    // Network-level failure (DNS, connection reset, timeout).
    throw new TokenPersistenceError(
      `Railway API request failed for ${subEntity} → ${envName}: ${err.message}`
    );
  }

  // A non-2xx HTTP status means the write did NOT land — fail closed.
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (_) { /* ignore body read failure */ }
    throw new TokenPersistenceError(
      `Railway API returned HTTP ${response.status} for ${subEntity} → ${envName}` +
      (detail ? `: ${detail.slice(0, 500)}` : '')
    );
  }

  // GraphQL can return HTTP 200 with an `errors` array — that is still a failed write.
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new TokenPersistenceError(
      `Railway API returned unparseable response for ${subEntity} → ${envName}: ${err.message}`
    );
  }

  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const messages = body.errors.map((e) => e && e.message).filter(Boolean).join('; ');
    throw new TokenPersistenceError(
      `Railway API GraphQL error for ${subEntity} → ${envName}: ${messages || 'unknown GraphQL error'}`
    );
  }

  // A structurally valid HTTP 200 with no `errors` array is still not proof the
  // write landed — Railway can return `{ data: { variableUpsert: false } }` or
  // `{ data: null }`. The mutation contract is `variableUpsert: Boolean`, so
  // require an explicit `true` before treating the write as durable.
  if (!body || !body.data || body.data.variableUpsert !== true) {
    let summary;
    try { summary = JSON.stringify(body); } catch (_) { summary = String(body); }
    throw new TokenPersistenceError(
      `Railway API did not confirm the write for ${subEntity} → ${envName} ` +
      `(expected data.variableUpsert === true): ${String(summary).slice(0, 500)}`
    );
  }

  console.log(`Persisted rotated token for ${subEntity} → ${envName}`);
}

// Load all sub-entity tokens from env vars (JOBBER_REFRESH_TOKEN_{SUB_ENTITY})
function loadTokens() {
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^JOBBER_REFRESH_TOKEN_(.+)$/);
    if (match && value) {
      const subEntity = match[1].toLowerCase().replace(/_/g, '-');
      refreshTokens[subEntity] = value;
    }
  }
  // Backward compat: bare JOBBER_REFRESH_TOKEN maps to 'default'
  if (process.env.JOBBER_REFRESH_TOKEN && !refreshTokens['default']) {
    refreshTokens['default'] = process.env.JOBBER_REFRESH_TOKEN;
  }
}

// Test helper: clear the in-memory token map (and the non-durable marker set)
// and re-seed it directly. Lets the suite register a known sub-entity without
// going through env vars, and keeps tests independent of each other.
function _setTokensForTest(tokens) {
  for (const key of Object.keys(refreshTokens)) delete refreshTokens[key];
  nonDurableTokens.clear();
  Object.assign(refreshTokens, tokens || {});
}

// Test helper: read the current in-memory refresh token for a sub-entity, so
// the suite can assert what the service retained after a persistence failure.
function _getTokenForTest(subEntity) {
  return refreshTokens[subEntity];
}

loadTokens();

// GET /token/:subEntity — refresh token for a specific sub-entity
// GET /token — backward compat, uses 'default' or first available
app.get('/token/:subEntity?', async (req, res) => {
  const subEntity = (req.params.subEntity || 'default').toLowerCase();

  if (!refreshTokens[subEntity]) {
    // Explicit rejection: the sub-entity is not registered (no refresh-token slot,
    // or the slot exists but is empty/stubbed — e.g. icare before acquisition close).
    const available = Object.keys(refreshTokens);
    return res.status(404).json({
      error: `Sub-entity '${subEntity}' is not registered`,
      detail: `No refresh token is configured for '${subEntity}'. ` +
        `Set JOBBER_REFRESH_TOKEN_${subEntity.toUpperCase().replace(/-/g, '_')} ` +
        `and restart the service to register it.`,
      sub_entity: subEntity,
      available_sub_entities: available
    });
  }

  let data;
  try {
    const response = await fetch('https://api.getjobber.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokens[subEntity],
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET
      })
    });

    data = await response.json();

    // Surface upstream Jobber rejection so callers can distinguish a stale/dead
    // refresh token from a healthy one. A non-2xx status OR an OAuth `error` field
    // (Jobber returns `invalid_grant` for a rejected/expired refresh token) means
    // the token is bad — return 502 Bad Gateway, never a misleading 200.
    if (!response.ok || data.error || !data.access_token) {
      return res.status(502).json({
        error: 'Jobber rejected the refresh token',
        jobber_status: response.status,
        jobber_error: data.error || null,
        jobber_error_description: data.error_description || null,
        sub_entity: subEntity
      });
    }

  } catch (err) {
    // Network-level failure reaching Jobber — upstream unreachable.
    return res.status(502).json({
      error: `Failed to reach Jobber OAuth endpoint: ${err.message}`,
      sub_entity: subEntity
    });
  }

  // Jobber rotates refresh tokens and the OLD token may already be revoked the
  // moment this refresh succeeded. So the rotated token is the ONLY valid token
  // now — it MUST go into memory immediately, regardless of whether the durable
  // write to Railway then succeeds. (Discarding it on a Railway failure would
  // turn a transient blip into a hard invalid_grant outage, because the next
  // request would retry with the revoked old token.)
  //
  // Persistence to Railway is a SEPARATE durability concern. If it fails, the
  // in-memory token still works for the life of this process; we mark the
  // sub-entity non-durable and return 503 so the caller knows a restart would
  // lose the token — but the token itself is kept, not thrown away.
  if (data.refresh_token) {
    refreshTokens[subEntity] = data.refresh_token;
    try {
      await persistTokenToRailway(subEntity, data.refresh_token);
      nonDurableTokens.delete(subEntity);
    } catch (err) {
      nonDurableTokens.add(subEntity);
      console.error(`Token persistence failed for ${subEntity}: ${err.message}`);
      return res.status(503).json({
        error: 'Refresh token rotated and is in use, but could not be persisted',
        detail: `Jobber rotated the refresh token for '${subEntity}'. The new token ` +
          `is held in memory and works for now, but writing it back to Railway ` +
          `failed — a service restart would lose it. Investigate Railway API ` +
          `credentials/IDs before relying on this sub-entity across a restart.`,
        non_durable: true,
        sub_entity: subEntity
      });
    }
  }

  res.json({
    access_token: data.access_token,
    sub_entity: subEntity
  });
});

// GET /auth — kick off OAuth flow (redirects browser to Jobber)
app.get('/auth', (req, res) => {
  const subEntity = req.query.sub_entity || 'default';
  const authUrl = `https://api.getjobber.com/api/oauth/authorize?` +
    `client_id=${process.env.JOBBER_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.OAUTH_CALLBACK_URL || `https://${req.get('host')}/callback`)}` +
    `&response_type=code` +
    `&state=${subEntity}`;
  res.redirect(authUrl);
});

// GET /callback — Jobber redirects here after user clicks "Allow"
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const subEntity = (state || 'default').toLowerCase();

  if (!code) {
    return res.status(400).send('Missing authorization code. Did you deny access?');
  }

  try {
    // Exchange the authorization code for access + refresh tokens
    const response = await fetch('https://api.getjobber.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        redirect_uri: process.env.OAUTH_CALLBACK_URL || `https://${req.get('host')}/callback`
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error, description: data.error_description });
    }

    // A fresh OAuth grant produces a brand-new refresh token — keep it in
    // memory immediately so a Railway persistence failure does not throw away
    // a token the user just authorized. Then attempt the durable write; on
    // failure, mark the sub-entity non-durable and report it, but retain the
    // working token. Same model as the /token route.
    if (data.refresh_token) {
      refreshTokens[subEntity] = data.refresh_token;
      try {
        await persistTokenToRailway(subEntity, data.refresh_token);
        nonDurableTokens.delete(subEntity);
      } catch (err) {
        nonDurableTokens.add(subEntity);
        console.error(`Token persistence failed for ${subEntity}: ${err.message}`);
        return res.status(503).send(
          `<h2>Jobber OAuth completed for "${subEntity}" — but persistence FAILED</h2>` +
          `<p>An access token was obtained and the refresh token is held in memory ` +
          `(it works for now), but writing it back to Railway failed: ${err.message}</p>` +
          `<p><strong>A service restart would lose this token.</strong> ` +
          `Fix the Railway API credentials/IDs, then re-run the OAuth flow to persist it.</p>`
        );
      }
    }

    res.send(
      `<h2>Jobber OAuth complete for "${subEntity}"</h2>` +
      `<p>Access token obtained. Refresh token stored in memory and persisted to Railway.</p>` +
      `<p>The service is now ready to serve tokens via <code>GET /token/${subEntity}</code></p>`
    );

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /accounts — list registered sub-entities (no secrets exposed).
// `non_durable_sub_entities` flags any sub-entity whose in-memory refresh token
// is newer than what Railway holds — i.e. a persistence write-back failed and a
// service restart would lose the rotated token. A monitor can poll this to catch
// the durability gap without having to exercise the refresh path.
app.get('/accounts', (req, res) => {
  res.json({
    sub_entities: Object.keys(refreshTokens),
    count: Object.keys(refreshTokens).length,
    non_durable_sub_entities: Array.from(nonDurableTokens)
  });
});

// Only bind a port when run directly (`node index.js`). When the file is
// `require`d by the test suite, the app is exercised in-process without listening.
if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    const count = Object.keys(refreshTokens).length;
    console.log(`Jobber token service running — ${count} sub-entity account(s) loaded`);
  });
}

module.exports = {
  app,
  persistTokenToRailway,
  TokenPersistenceError,
  loadTokens,
  setFetch,
  _setTokensForTest,
  _getTokenForTest
};
