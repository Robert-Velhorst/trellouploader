import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupApp, SESSION_COOKIE } from '../backup-app.js';

const password = 'synthetic-password-for-tests-only';
const origin = 'https://backup.example.test';
const link = 'https://drive.google.com/file/d/synthetic-file';
const intent = { 'X-Backup-Request': '1', Origin: origin };

async function fixture(t, overrides = {}) {
  let calls = 0;
  const csrfTokens = new Map();
  const app = createBackupApp({ password, publicOrigin: origin, runBackup: async () => { calls++; return link; }, ...overrides });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfTokens.has(headers.Cookie) ? { 'X-CSRF-Token': csrfTokens.get(headers.Cookie) } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data };
  }
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { password } });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(cookie); csrfTokens.set(cookie.split(';')[0], response.data.csrfToken); return { cookie: cookie.split(';')[0], response, setCookie: cookie };
  }
  return { request, login, calls: () => calls };
}

test('configuration requires a strong explicit password and HTTPS browser origin', () => {
  for (const value of [undefined, '', 'short']) assert.throws(() => createBackupApp({ password: value, runBackup() {} }), /APP_PASSWORD/);
  assert.throws(() => createBackupApp({ password, publicOrigin: 'http://public.example', runBackup() {} }), /HTTPS/);
});

test('client-created and legacy markers cannot authorize backup work', async t => {
  const f = await fixture(t);
  for (const cookie of ['', 'auth=ok', `${SESSION_COOKIE}=ok`, `${SESSION_COOKIE}=j:%7B%7D`, `${SESSION_COOKIE}=${'A'.repeat(43)}`]) {
    assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: cookie, ...intent } })).status, 401);
    assert.equal((await f.request('/api/backup', { headers: { Cookie: cookie } })).status, 401);
  }
  assert.equal(f.calls(), 0);
});

test('login issues opaque distinct secure host-only sessions without caching', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password: 'incorrect' } })).status, 401);
  const first = await f.login(), second = await f.login();
  assert.notEqual(first.cookie, second.cookie);
  assert.match(first.setCookie, /HttpOnly/); assert.match(first.setCookie, /Secure/);
  assert.match(first.setCookie, /SameSite=Strict/); assert.match(first.setCookie, /Path=\//);
  assert.doesNotMatch(first.setCookie, /Domain=/);
  assert.equal(first.response.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls(), 0);
});

test('backup work requires POST, explicit intent and the configured browser origin', async t => {
  const f = await fixture(t), { cookie } = await f.login();
  const legacy = await f.request('/api/backup', { headers: { Cookie: cookie } });
  assert.equal(legacy.status, 405); assert.equal(legacy.headers.get('allow'), 'POST');
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: cookie, ...intent, Origin: 'https://other.example.test' } })).status, 403);
  assert.equal(f.calls(), 0);
  const response = await f.request('/api/backup', { method: 'POST', headers: { Cookie: cookie, ...intent } });
  assert.equal(response.status, 200); assert.equal(response.data.status, 'completed');
  assert.equal(response.data.driveUrl, link); assert.equal(f.calls(), 1);
});

test('expired, tampered and explicitly revoked sessions fail closed', async t => {
  let now = 10_000;
  const f = await fixture(t, { now: () => now, sessionTtlMs: 1000 });
  const first = await f.login();
  const token = first.cookie.split('=')[1];
  const altered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${altered}`, ...intent } })).status, 401);
  now += 1001;
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: first.cookie, ...intent } })).status, 401);
  const second = await f.login();
  const logout = await f.request('/api/logout', { method: 'POST', headers: { Cookie: second.cookie, ...intent } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.getSetCookie()[0], /HttpOnly/);
  assert.match(logout.headers.getSetCookie()[0], /Secure/);
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: second.cookie, ...intent } })).status, 401);
  assert.equal(f.calls(), 0);
});

test('failed login attempts are bounded', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/login', { method: 'POST', body: { password: 'incorrect' } })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password } })).status, 429);
  assert.equal(f.calls(), 0);
});

test('background acceptance is separate from completion and job access is session-bound', async t => {
  let complete, runs = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const f = await fixture(t, { background: true, runBackup: () => { runs++; return pending; } });
  t.after(() => complete(link));
  const first = await f.login(), second = await f.login();
  const response = await f.request('/api/backup', { method: 'POST', headers: { Cookie: first.cookie, ...intent } });
  assert.equal(response.status, 202); assert.equal(response.data.accepted, true);
  assert.equal(response.data.status, 'running'); assert.equal(response.data.driveUrl, undefined);
  const path = `/api/backup/${response.data.jobId}`;
  assert.equal((await f.request(path, { headers: { Cookie: first.cookie } })).data.status, 'running');
  assert.equal((await f.request(path, { headers: { Cookie: second.cookie } })).status, 404);
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: first.cookie, ...intent } })).status, 409);
  complete(link);
  let state;
  for (let i = 0; i < 10; i++) {
    state = await f.request(path, { headers: { Cookie: first.cookie } });
    if (state.data.status === 'completed') break;
    await new Promise(done => setTimeout(done, 5));
  }
  assert.equal(state.data.status, 'completed'); assert.equal(state.data.driveUrl, link); assert.equal(runs, 1);
});

test('provider failures remain redacted in synchronous and background results', async t => {
  for (const background of [false, true]) {
    const f = await fixture(t, { background, runBackup: async () => { throw new Error('synthetic-private-provider-value'); } });
    const { cookie } = await f.login();
    let response = await f.request('/api/backup', { method: 'POST', headers: { Cookie: cookie, ...intent } });
    if (background) response = await f.request(`/api/backup/${response.data.jobId}`, { headers: { Cookie: cookie } });
    assert.equal(response.data.error, 'Backup failed');
    assert.doesNotMatch(JSON.stringify(response.data), /synthetic-private-provider-value/);
  }
});

test('malformed and oversized JSON do not reveal input values', async t => {
  const f = await fixture(t);
  const result = await f.request('/api/login', { method: 'POST', body: { password: 'x'.repeat(5000) } });
  assert.equal(result.status, 413); assert.equal(result.data.error, 'Request too large');
  assert.doesNotMatch(JSON.stringify(result.data), /xxxxx/);
});


test('mutating requests require the initiating session CSRF token', async t => {
  const f = await fixture(t), first = await f.login(), second = await f.login();
  for (const token of ['', 'invalid-token', second.response.data.csrfToken]) {
    for (const path of ['/api/backup', '/api/logout']) {
      const response = await f.request(path, { method: 'POST', headers: { Cookie: first.cookie, ...intent, 'X-CSRF-Token': token } });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: { Cookie: first.cookie, ...intent } })).status, 200);
  assert.equal(f.calls(), 1);
});


test('backup and logout attempts share a bounded mutation rate', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    const response = await f.request(i % 2 ? '/api/logout' : '/api/backup', { method: 'POST', headers: intent });
    assert.equal(response.status, 401);
  }
  assert.equal((await f.request('/api/backup', { method: 'POST', headers: intent })).status, 429);
  assert.equal(f.calls(), 0);
});
