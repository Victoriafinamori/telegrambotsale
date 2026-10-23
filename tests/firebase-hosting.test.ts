import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, testConfig } from './helpers.js';
import { loadConfig } from '../server/config.js';

test('Firebase Hosting mantém sessão e CSRF usando somente o cookie __session', async () => {
  const config = {
    ...testConfig(),
    secure: true,
    FIREBASE_HOSTING: true,
    SESSION_COOKIE_SIGNING_KEY: randomBytes(32).toString('base64url'),
  };
  const f = await fixture(undefined, config);
  try {
    const a = await f.agent();
    await a.login('merchant');
    assert.deepEqual([...a.cookies.keys()], ['__session']);
    assert.equal((await a.request('/me')).status, 200);
    assert.equal(
      (await a.request('/auth/logout', {}, { 'X-CSRF-Token': 'x'.repeat(43) })).status,
      403,
    );
    // A fresh CSRF request replaces the envelope but preserves the Firebase identity.
    await a.request('/security/csrf');
    assert.equal((await a.request('/me')).status, 200);
    const genuine = a.cookies.get('__session')!;
    a.cookies.set('__session', genuine.slice(0, -1) + (genuine.endsWith('a') ? 'b' : 'a'));
    assert.equal((await a.request('/me')).status, 401);
    a.cookies.set('__session', genuine);
    const login = await a.login('merchant');
    const cookie = login.headers.getSetCookie().find((v) => v.startsWith('__session='))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert(!cookie.includes('Domain='));
    assert.equal((await a.request('/auth/logout', {})).status, 200);
    assert.equal((await a.request('/me')).status, 401);
    assert.equal(a.cookies.size, 0);
  } finally {
    await f.close();
  }
});

test('Firebase Hosting de produção exige assinatura da sessão em segredo próprio', () => {
  const base = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://blackout-create.web.app',
    DATABASE_URL: 'postgresql://localhost/blackout',
    DATABASE_SSL: 'true',
    FIREBASE_HOSTING: 'true',
  };
  assert.throws(() => loadConfig(base));
  assert.equal(
    loadConfig({ ...base, SESSION_COOKIE_SIGNING_KEY: randomBytes(32).toString('base64url') })
      .FIREBASE_HOSTING,
    true,
  );
});
