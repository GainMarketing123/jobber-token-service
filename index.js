const express = require('express');
const fetch = require('node-fetch');
const app = express();

// Multi-account token storage — one refresh token per sub-entity.
// Each sub-entity (across any brand umbrella) has its own Jobber account
// but shares the same app credentials (client_id + client_secret).
const refreshTokens = {};

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

loadTokens();

// GET /token/:subEntity — refresh token for a specific sub-entity
// GET /token — backward compat, uses 'default' or first available
app.get('/token/:subEntity?', async (req, res) => {
  const subEntity = (req.params.subEntity || 'default').toLowerCase();

  if (!refreshTokens[subEntity]) {
    const available = Object.keys(refreshTokens);
    return res.status(404).json({
      error: `No refresh token for sub-entity '${subEntity}'`,
      available_sub_entities: available
    });
  }

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

    const data = await response.json();

    // Jobber rotates refresh tokens — store the new one
    if (data.refresh_token) {
      refreshTokens[subEntity] = data.refresh_token;
    }

    res.json({
      access_token: data.access_token,
      sub_entity: subEntity
    });

  } catch (err) {
    res.status(500).json({ error: err.message, sub_entity: subEntity });
  }
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

    // Store the fresh refresh token in memory
    if (data.refresh_token) {
      refreshTokens[subEntity] = data.refresh_token;
    }

    res.send(
      `<h2>Jobber OAuth complete for "${subEntity}"</h2>` +
      `<p>Access token obtained. Refresh token stored in memory.</p>` +
      `<p>The service is now ready to serve tokens via <code>GET /token/${subEntity}</code></p>`
    );

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /accounts — list registered sub-entities (no secrets exposed)
app.get('/accounts', (req, res) => {
  res.json({
    sub_entities: Object.keys(refreshTokens),
    count: Object.keys(refreshTokens).length
  });
});

app.listen(process.env.PORT || 3000, () => {
  const count = Object.keys(refreshTokens).length;
  console.log(`Jobber token service running — ${count} sub-entity account(s) loaded`);
});
