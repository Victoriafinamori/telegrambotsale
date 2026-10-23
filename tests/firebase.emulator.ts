import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { firebaseIdentity } from '../server/firebase.js';
import { fixture, testConfig } from './helpers.js';
test('Firebase Auth real no emulador: verificação de e-mail, sessão e revogação', async () => {
  assert.equal(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    '127.0.0.1:9099',
    'Este teste só pode executar no emulador local.',
  );
  const config = { ...testConfig(), FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
    provider = firebaseIdentity(config),
    f = await fixture(provider, {
      ...testConfig(),
      FIREBASE_HOSTING: true,
      SESSION_COOKIE_SIGNING_KEY: randomBytes(32).toString('base64url'),
    });
  async function rest(method: string, body: unknown) {
    const response = await fetch(
      'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:' +
        method +
        '?key=demo-key',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    const email = 'firebase-' + Date.now() + '@example.test',
      password = 'LocalVerification!42';
    const signup = await rest('signUp', { email, password, returnSecureToken: true }),
      agent = await f.agent();
    const unverified = await agent.request('/auth/session', { idToken: signup.idToken });
    assert.equal(unverified.status, 403);
    const admin = getAuth(getApp(config.FIREBASE_PROJECT_ID));
    await admin.updateUser(signup.localId, { emailVerified: true });
    const login = await rest('signInWithPassword', { email, password, returnSecureToken: true });
    const response = await agent.request('/auth/session', { idToken: login.idToken });
    assert.equal(response.status, 200);
    const me = await (await agent.request('/me')).json();
    assert.equal(me.user.email, email);
    assert.equal(me.role, 'unassigned');
    assert.equal((await agent.request('/admin/accounts')).status, 403);
    await f.db.query('INSERT INTO platform_admins(firebase_uid) VALUES($1)', [signup.localId]);
    assert.equal((await agent.request('/admin/accounts')).status, 200);
    const forged = login.idToken.slice(0, -12) + 'aaaaaaaaaaaa';
    assert.equal((await agent.request('/auth/session', { idToken: forged })).status, 401);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await admin.revokeRefreshTokens(signup.localId);
    assert.equal((await agent.request('/me')).status, 401);
    await admin.deleteUser(signup.localId);
  } finally {
    await f.close();
  }
});
