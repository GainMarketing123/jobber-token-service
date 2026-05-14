const test = require('node:test');
const assert = require('node:assert/strict');
const fetch = require('node-fetch');

const {
  app,
  persistTokenToRailway,
  TokenPersistenceError,
  setFetch,
  _setTokensForTest,
  _getTokenForTest,
} = require('./index');

function createResponse({ ok, status, jsonBody, textBody = '' }) {
  return {
    ok,
    status,
    json: async () => jsonBody,
    text: async () => textBody,
  };
}

async function startApp() {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

let currentServer;
let fetchStub;

test.beforeEach(() => {
  process.env.RAILWAY_API_TOKEN = 'railway-test-token';
  process.env.RAILWAY_PROJECT_ID = 'project-test-id';
  process.env.RAILWAY_ENVIRONMENT_ID = 'environment-test-id';
  process.env.RAILWAY_SERVICE_ID = 'service-test-id';

  _setTokensForTest({});

  fetchStub = async () => {
    throw new Error('Unexpected fetch call in test');
  };
  setFetch(fetchStub);
});

test.afterEach(async () => {
  if (currentServer) {
    await new Promise((resolve, reject) => {
      currentServer.close((err) => (err ? reject(err) : resolve()));
    });
    currentServer = undefined;
  }

  setFetch(fetch);
});

test.describe('persistTokenToRailway — finding 2.2: fail closed on Railway write failure', () => {
  test('t1: resolves when RAILWAY_API_TOKEN is unset', async () => {
    delete process.env.RAILWAY_API_TOKEN;

    await assert.doesNotReject(async () => {
      await persistTokenToRailway('wise-gd', 'tok');
    });
  });

  test('t2: throws TokenPersistenceError on non-2xx Railway response', async () => {
    fetchStub = async () =>
      createResponse({
        ok: false,
        status: 500,
        jsonBody: {},
        textBody: 'server error',
      });
    setFetch(fetchStub);

    await assert.rejects(
      persistTokenToRailway('wise-gd', 'tok'),
      TokenPersistenceError
    );
  });

  test('t3: throws TokenPersistenceError on GraphQL errors in a 200 response', async () => {
    fetchStub = async () =>
      createResponse({
        ok: true,
        status: 200,
        jsonBody: { errors: [{ message: 'Unauthorized' }] },
        textBody: '',
      });
    setFetch(fetchStub);

    await assert.rejects(
      persistTokenToRailway('wise-gd', 'tok'),
      TokenPersistenceError
    );
  });

  test('t4: throws TokenPersistenceError on Railway network failure', async () => {
    fetchStub = async () => Promise.reject(new Error('ECONNRESET'));
    setFetch(fetchStub);

    await assert.rejects(
      persistTokenToRailway('wise-gd', 'tok'),
      TokenPersistenceError
    );
  });

  test('t5: resolves when Railway persistence succeeds', async () => {
    fetchStub = async () =>
      createResponse({
        ok: true,
        status: 200,
        jsonBody: { data: { variableUpsert: true } },
        textBody: '',
      });
    setFetch(fetchStub);

    await assert.doesNotReject(async () => {
      await persistTokenToRailway('wise-gd', 'tok');
    });
  });

  test('t5b: throws when Railway returns 200 but does not confirm the write', async () => {
    // Railway can return a structurally valid 200 with no `errors` array yet
    // still report the mutation did not land (variableUpsert: false / data: null).
    // That must NOT be treated as a durable write.
    fetchStub = async () =>
      createResponse({
        ok: true,
        status: 200,
        jsonBody: { data: { variableUpsert: false } },
        textBody: '',
      });
    setFetch(fetchStub);

    await assert.rejects(
      persistTokenToRailway('wise-gd', 'tok'),
      TokenPersistenceError
    );
  });
});

test.describe('GET /token/:subEntity — finding 2.1: surface Jobber rejection as 502', () => {
  test('t6: returns 502 and exposes Jobber invalid_grant', async () => {
    _setTokensForTest({ 'wise-gd': 'refresh-abc' });
    fetchStub = async () =>
      createResponse({
        ok: false,
        status: 401,
        jsonBody: {
          error: 'invalid_grant',
          error_description: 'token revoked',
        },
        textBody: '',
      });
    setFetch(fetchStub);

    const { server, baseUrl } = await startApp();
    currentServer = server;

    const response = await fetch(`${baseUrl}/token/wise-gd`);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.jobber_error, 'invalid_grant');
  });

  test('t7: returns 200 when Jobber refresh and Railway persistence both succeed', async () => {
    _setTokensForTest({ 'wise-gd': 'refresh-abc' });
    fetchStub = async (url) => {
      if (url.includes('getjobber.com')) {
        return createResponse({
          ok: true,
          status: 200,
          jsonBody: { access_token: 'AT-1', refresh_token: 'RT-2' },
          textBody: '',
        });
      }

      if (url.includes('railway.com')) {
        return createResponse({
          ok: true,
          status: 200,
          jsonBody: { data: { variableUpsert: true } },
          textBody: '',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    setFetch(fetchStub);

    const { server, baseUrl } = await startApp();
    currentServer = server;

    const response = await fetch(`${baseUrl}/token/wise-gd`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.access_token, 'AT-1');
  });

  test('t8: returns 503 when Jobber succeeds but Railway persistence fails', async () => {
    _setTokensForTest({ 'wise-gd': 'refresh-abc' });
    fetchStub = async (url) => {
      if (url.includes('getjobber.com')) {
        return createResponse({
          ok: true,
          status: 200,
          jsonBody: { access_token: 'AT-1', refresh_token: 'RT-2' },
          textBody: '',
        });
      }

      if (url.includes('railway.com')) {
        return createResponse({
          ok: false,
          status: 500,
          jsonBody: {},
          textBody: 'err',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    setFetch(fetchStub);

    const { server, baseUrl } = await startApp();
    currentServer = server;

    const response = await fetch(`${baseUrl}/token/wise-gd`);

    assert.equal(response.status, 503);
    assert.notEqual(response.status, 200);
  });

  test('t8b: rotated token is RETAINED in memory when Railway persistence fails', async () => {
    // Jobber rotates single-use refresh tokens — once the refresh succeeds the
    // OLD token may already be revoked. So even though persistence failed (503),
    // the NEW token must be kept in memory; discarding it would turn a transient
    // Railway blip into a hard invalid_grant outage on the next request.
    _setTokensForTest({ 'wise-gd': 'refresh-OLD' });
    fetchStub = async (url) => {
      if (url.includes('getjobber.com')) {
        return createResponse({
          ok: true,
          status: 200,
          jsonBody: { access_token: 'AT-1', refresh_token: 'refresh-NEW' },
          textBody: '',
        });
      }
      if (url.includes('railway.com')) {
        return createResponse({
          ok: false,
          status: 500,
          jsonBody: {},
          textBody: 'err',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    setFetch(fetchStub);

    const { server, baseUrl } = await startApp();
    currentServer = server;

    const response = await fetch(`${baseUrl}/token/wise-gd`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.non_durable, true);
    // The in-memory token is the freshly rotated one, NOT the (possibly revoked) old one.
    assert.equal(_getTokenForTest('wise-gd'), 'refresh-NEW');
  });
});

test.describe('GET /token/:subEntity — finding 2.3: explicit rejection for unregistered sub-entity', () => {
  test("t9: returns 404 when the sub-entity is not registered", async () => {
    _setTokensForTest({ 'wise-gd': 'refresh-abc' });

    const { server, baseUrl } = await startApp();
    currentServer = server;

    const response = await fetch(`${baseUrl}/token/icare`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /not registered/i);
  });
});
