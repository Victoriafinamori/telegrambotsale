import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, testConfig } from './helpers.js';
import { loadConfig } from '../server/config.js';
import { enforceAdminSecondFactor } from '../server/admin-policy.js';
test('Acesso manual e convites: autorização, isolamento, revogação e ausência de cobrança antecipada', async () => {
  const f = await fixture();
  try {
    await f.db.query('INSERT INTO platform_admins(firebase_uid) VALUES($1)', ['admin']);
    const admin = await f.agent(),
      merchant = await f.agent(),
      stranger = await f.agent(),
      anon = await f.agent();
    assert.equal((await anon.request('/admin/accounts')).status, 401);
    await admin.login('admin');
    await merchant.login('merchant');
    await stranger.login('stranger');
    assert.equal((await merchant.request('/admin/accounts')).status, 403);
    assert.equal((await stranger.request('/store')).status, 403);
    const registration = {
      name: 'Lojista',
      email: 'merchant@example.com',
      storeName: 'Loja segura',
      channel: 'discord',
      reference: 'Conversa manual',
      priceCents: 4990,
    };
    const created = await admin.request('/admin/accounts', registration);
    assert.equal(created.status, 201);
    const { account } = await created.json();
    assert.equal(account.billing_started_at, null);
    assert.equal(account.paid_through, null);
    assert.equal(
      (await admin.request('/admin/accounts', { ...registration, role: 'platform' })).status,
      400,
    );
    assert.equal((await admin.request('/admin/accounts', registration)).status, 409);
    assert.equal(
      (await admin.request('/admin/accounts/' + account.id + '/approve', {})).status,
      409,
    );
    assert.equal(
      (await admin.request('/admin/accounts/' + account.id + '/invitations', {})).status,
      409,
    );
    assert.equal(
      (await admin.request('/admin/accounts/' + account.id + '/confirm-purchase', {})).status,
      200,
    );
    const first = await (
        await admin.request('/admin/accounts/' + account.id + '/invitations', {})
      ).json(),
      second = await (
        await admin.request('/admin/accounts/' + account.id + '/invitations', {})
      ).json();
    const token = (url: string) =>
      new URLSearchParams(new URL(url).hash.split('?')[1]).get('token')!;
    assert.equal(
      (await anon.request('/invitations/inspect', { token: token(first.url) })).status,
      410,
    );
    const current = token(second.url);
    assert.equal(current.length, 43);
    const inspect = await (await anon.request('/invitations/inspect', { token: current })).json();
    assert.equal(inspect.emailHint, 'm***@example.com');
    assert(!('email' in inspect));
    const stored = await f.db.query('SELECT * FROM merchant_invitations');
    assert(!JSON.stringify(stored.rows).includes(current));
    assert(!JSON.stringify(stored.rows).includes(first.url));
    assert.equal((await stranger.request('/invitations/accept', { token: current })).status, 403);
    const claim = await merchant.request('/invitations/accept', { token: current });
    assert.equal(claim.status, 200);
    assert.equal((await merchant.request('/invitations/accept', { token: current })).status, 200);
    assert.equal(
      (await merchant.request('/store')).status,
      200,
      'The owner-issued invitation grants access without another approval',
    );
    assert.equal(
      (await merchant.request('/admin/accounts/' + account.id + '/approve', {})).status,
      403,
    );
    await admin.request('/admin/accounts/' + account.id + '/approve', {});
    const store = await merchant.request('/store');
    assert.equal(store.status, 200);
    const state = await store.json();
    assert.equal(state.account.id, account.id);
    assert.equal(state.billingStartsOn, 'bot_activation');
    assert.equal(state.account.billing_started_at, null);
    assert.equal((await stranger.request('/store?accountId=' + account.id)).status, 403);
    assert.equal(
      (
        await admin.request('/admin/accounts/' + account.id + '/suspend', {
          reason: 'Revisão manual',
        })
      ).status,
      200,
    );
    assert.equal((await merchant.request('/store')).status, 403);
    assert.equal((await merchant.request('/me')).status, 200);
    assert.equal(
      (await merchant.request('/admin/accounts/' + account.id + '/restore', {})).status,
      403,
    );
    await admin.request('/admin/accounts/' + account.id + '/restore', {});
    assert.equal((await merchant.request('/store')).status, 200);
    const events = await (await admin.request('/admin/audit')).json();
    assert(events.events.some((v: { action: string }) => v.action === 'access.approved_by_invitation'));
    assert(!JSON.stringify(events).includes(current));
    await f.db.query('DELETE FROM platform_admins WHERE firebase_uid=$1', ['admin']);
    assert.equal((await admin.request('/admin/accounts')).status, 403);
  } finally {
    await f.close();
  }
});
test('Sessão, CSRF, origem, entradas e cabeçalhos de segurança', async () => {
  const f = await fixture();
  try {
    const a = await f.agent();
    assert.equal(
      (
        await a.request(
          '/auth/session',
          { idToken: 'test-token:admin' },
          { Origin: 'https://attacker.example' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await a.request(
          '/auth/session',
          { idToken: 'test-token:admin' },
          { 'X-CSRF-Token': 'x'.repeat(43) },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await a.request(
          '/auth/session',
          { idToken: 'test-token:admin' },
          { 'X-CSRF-Token': 'é'.repeat(43) },
        )
      ).status,
      403,
    );
    assert.equal(
      (await a.request('/auth/session', { idToken: 'test-token:unverified' })).status,
      403,
    );
    assert.equal((await a.request('/auth/session', { idToken: 'test-token:stale' })).status, 401);
    assert.equal((await a.request('/auth/session', { idToken: 'invalid-token' })).status, 401);
    const login = await a.login('user');
    const cookie = login.headers.getSetCookie().find((v) => v.startsWith('blackout_session='))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    const me = await a.request('/me');
    assert.equal(me.headers.get('cache-control'), 'no-store');
    assert.match(me.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(me.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(me.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(me.headers.get('x-powered-by'), null);
    a.cookies.set('blackout_session', 'tampered');
    assert.equal((await a.request('/me')).status, 401);
    await a.login('user');
    await a.request('/auth/logout', {});
    assert.equal((await a.request('/me')).status, 401);
    const r = await a.request('/invitations/inspect', {
      token: "'; DROP TABLE merchant_accounts; --",
    });
    assert.equal(r.status, 400);
    assert.equal(
      (await a.request('/invitations/inspect', { token: randomBytes(32).toString('base64url') }))
        .status,
      410,
    );
    assert.equal(
      (await a.request('/invitations/inspect', { token: 'x'.repeat(20000) })).status,
      413,
    );
  } finally {
    await f.close();
  }
});
test('Limites persistidos e convite vencido ou consumido em concorrência', async () => {
  const f = await fixture();
  try {
    await f.accounts.consumeRate('limited', 1, 60000);
    await assert.rejects(f.accounts.consumeRate('limited', 1, 60000), { status: 429 });
    const account = await f.accounts.register(
      {
        name: 'A',
        email: 'a@example.com',
        storeName: 'Loja A',
        channel: 'whatsapp',
        reference: '',
        priceCents: 1000,
      },
      'admin',
    );
    await f.accounts.confirm(account.id, 'admin');
    const expired = await f.accounts.invite(account.id, 'admin');
    await f.db.query("UPDATE merchant_invitations SET expires_at=now()-interval '1 second'");
    await assert.rejects(f.accounts.inspect(expired.token), { status: 410 });
    await f.accounts.suspend(account.id, 'Revisão', 'admin');
    const restored = await f.accounts.restore(account.id, 'admin');
    assert.equal(restored.access_status, 'pending');
    assert.equal(restored.approved_at, null);
    const invitation = await f.accounts.invite(account.id, 'admin'),
      identity = {
        uid: 'a',
        email: 'a@example.com',
        emailVerified: true,
        authTime: Date.now() / 1000,
      };
    const results = await Promise.allSettled([
      f.accounts.accept(invitation.token, identity),
      f.accounts.accept(invitation.token, identity),
    ]);
    assert.equal(results.filter((v) => v.status === 'fulfilled').length, 2);
    assert.equal((await f.accounts.own('a'))?.access_status, 'approved');
    assert.equal(results.filter((v) => v.status === 'rejected').length, 0);
    assert.equal(
      (await f.db.query('SELECT * FROM merchant_accounts WHERE firebase_uid=$1', ['a'])).rows
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('Configuração de produção recusa emulador, HTTP, projeto demo e banco sem TLS', () => {
  const c = testConfig(),
    base = {
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://app.example.com',
      FIREBASE_PROJECT_ID: 'blackout-real',
      FIREBASE_WEB_API_KEY: 'public-key',
      FIREBASE_AUTH_DOMAIN: 'blackout-real.firebaseapp.com',
      DATABASE_URL: 'postgresql://localhost/db',
      DATABASE_SSL: 'true',
    };
  assert.equal(loadConfig(base).secure, true);
  for (const patch of [
    { APP_ORIGIN: 'http://app.example.com' },
    { FIREBASE_PROJECT_ID: c.FIREBASE_PROJECT_ID },
    { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
    { DATABASE_SSL: 'false' },
    { DATABASE_URL: '' },
    { DATABASE_URL: 'postgresql://localhost/db?sslmode=disable' },
  ])
    assert.throws(() => loadConfig({ ...base, ...patch }));
  assert.throws(() =>
    loadConfig({
      ...base,
      NODE_ENV: 'development',
      FIREBASE_AUTH_EMULATOR_HOST: 'remote.example:9099',
    }),
  );
});
test('Administração em produção exige segundo fator confirmado pelo provedor', () => {
  const user = {
    uid: 'admin',
    email: 'admin@example.test',
    emailVerified: true,
    authTime: Date.now() / 1000,
  };
  assert.throws(() => enforceAdminSecondFactor({ secure: true }, user), {
    code: 'ADMIN_MFA_REQUIRED',
  });
  assert.doesNotThrow(() =>
    enforceAdminSecondFactor({ secure: true }, { ...user, secondFactor: true }),
  );
  assert.doesNotThrow(() => enforceAdminSecondFactor({ secure: false }, user));
});
