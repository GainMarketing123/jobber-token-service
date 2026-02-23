const express = require('express');
const fetch = require('node-fetch');
const app = express();

let refreshToken = process.env.JOBBER_REFRESH_TOKEN;

app.get('/token', async (req, res) => {
  try {
    const response = await fetch('https://api.getjobber.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET
      })
    });

    const data = await response.json();

    if (data.refresh_token) {
      refreshToken = data.refresh_token;
    }

    res.json({ access_token: data.access_token });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Jobber token service running');
});
