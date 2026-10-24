import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { MemoryDocuments } from './document-memory.js';
import { createApp } from '../server/app.js';
import { testConfig } from './helpers.js';
import type { IdentityProvider, Identity } from '../server/types.js';
import { AdminMfa, totp, base32 } from '../server/admin-mfa.js';
import { tokenHash } from '../server/accounts.js';
import { nextBillingMonth } from '../server/billing-period.js';
const identity = (uid: string): Identity => ({
  uid,
  email: uid + '@example.test',
  emailVerified: true,
  authTime: Math.floor(Date.now() / 1000),
});
async function createMerchant(p: FirestorePlatform, uid = 'merchant') {
  const a = await p.register(
    {
      name: uid,
      email: uid + '@example.test',
      storeName: uid + ' Store',
      channel: 'telegram',
      reference: '',
      priceCents: 4990,
    },
    'admin',
  );
  await p.confirm(a.id, 'admin');
  const invitation = await p.invite(a.id, 'admin');
  await p.accept(invitation.token, identity(uid));
  await p.approve(a.id, 'admin');
  return a;
}
test('Firestore domain: invitation uniqueness, revocation, concurrent claim, approval and isolation', async () => {
  const store = new MemoryDocuments(),
    p = new FirestorePlatform(store, randomBytes(32).toString('base64url'));
  await p.grantAdmin('admin');
  assert(await p.isAdmin('admin'));
  assert(!(await p.isAdmin('other')));
  const registration = {
    name: 'Owner',
    email: 'merchant@example.test',
    storeName: 'Store',
    channel: 'discord' as const,
    reference: '',
    priceCents: 4990,
  };
  const created = await Promise.allSettled([
    p.register(registration, 'admin'),
    p.register(registration, 'admin'),
  ]);
  assert.equal(created.filter((r) => r.status === 'fulfilled').length, 1);
  const a = (await p.list(0))[0];
  assert.equal(a.billing_started_at, null);
  await p.confirm(a.id, 'admin');
  const old = await p.invite(a.id, 'admin'),
    invite = await p.invite(a.id, 'admin');
  await assert.rejects(() => p.inspect(old.token), { code: 'INVITE_UNAVAILABLE' });
  await assert.rejects(() => p.accept(invite.token, identity('other')), {
    code: 'INVITE_EMAIL_MISMATCH',
  });
  const claims = await Promise.allSettled([
    p.accept(invite.token, identity('merchant')),
    p.accept(invite.token, identity('merchant')),
  ]);
  assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
  await p.approve(a.id, 'admin');
  assert.equal((await p.own('merchant'))?.access_status, 'approved');
  assert.equal(await p.own('other'), null);
  await p.suspend(a.id, 'Review', 'admin');
  assert.equal((await p.own('merchant'))?.access_status, 'suspended');
  await p.restore(a.id, 'admin');
  assert.equal((await p.own('merchant'))?.access_status, 'approved');
  assert(!JSON.stringify(await p.history()).includes(invite.token));
  assert(!JSON.stringify(await p.own('merchant')).includes('invitation_generation'));
});
test('Firestore domain: encrypted onboarding, revision checks, unique app and one monthly period', async () => {
  const store = new MemoryDocuments(),
    p = new FirestorePlatform(store, randomBytes(32).toString('base64url'), async (token) => ({
      id: token.split(':')[0],
      username: 'DemoStoreBot',
    }));
  const a = await createMerchant(p),
    other = await createMerchant(p, 'other');
  const input = { botToken: '123456789:' + 'A'.repeat(35), telegramUserId: '987654321' };
  await p.onboarding.save('merchant', input);
  let setup = (await p.onboarding.submit('merchant'))!;
  assert.equal(await p.onboarding.reveal(a.id, 'admin'), input.botToken);
  const raw = await store.get('merchant_bot_secrets/' + a.id);
  assert(!JSON.stringify(raw).includes(input.botToken));
  assert(!JSON.stringify(await p.onboarding.own('merchant')).includes('ciphertext'));
  await assert.rejects(() => p.onboarding.save('other', input), { code: 'BOT_UNAVAILABLE' });
  setup = (await p.onboarding.review(a.id, 'admin', {
    action: 'configure',
    revision: setup.revision,
    note: '',
  }))!;
  await assert.rejects(() => p.onboarding.save('merchant', input), { code: 'BOT_CONFIGURING' });
  await assert.rejects(
    () =>
      p.onboarding.activate(a.id, 'admin', {
        revision: setup.revision - 1,
        deploymentReference: 'square-app-001',
      }),
    { code: 'BOT_SETUP_CHANGED' },
  );
  assert.equal((await p.own('merchant'))?.billing_started_at, null);
  const body = { revision: setup.revision, deploymentReference: 'square-app-001' };
  const [one, two] = await Promise.all([
    p.onboarding.activate(a.id, 'admin', body),
    p.onboarding.activate(a.id, 'admin', body),
  ]);
  assert.deepEqual(one.account, two.account);
  assert.equal((await p.list(0, 'activation')).length, 0);
  assert.equal(
    (await p.history()).filter((e) => e.action === 'bot_activation.confirmed_manually').length,
    1,
  );
  await p.onboarding.save('other', { ...input, botToken: '123456788:' + 'A'.repeat(35) });
  const second = (await p.onboarding.submit('other'))!;
  const reviewed = (await p.onboarding.review(other.id, 'admin', {
    action: 'configure',
    revision: second.revision,
    note: '',
  }))!;
  await assert.rejects(
    () =>
      p.onboarding.activate(other.id, 'admin', {
        revision: reviewed.revision,
        deploymentReference: 'square-app-001',
      }),
    { code: 'DEPLOYMENT_ALREADY_LINKED' },
  );
  assert.equal((await p.own('other'))?.billing_started_at, null);
});
test('Monthly periods respect São Paulo month boundaries and leap years', () => {
  const cases = [
    ['2026-01-31T15:00:00.123Z', '2026-02-28T15:00:00.123Z'],
    ['2028-01-31T15:00:00.000Z', '2028-02-29T15:00:00.000Z'],
    ['2026-03-01T01:30:00.000Z', '2026-03-29T01:30:00.000Z'],
    ['2026-12-31T23:00:00.000Z', '2027-01-31T23:00:00.000Z'],
  ];
  for (const [start, end] of cases)
    assert.equal(nextBillingMonth(new Date(start)).toISOString(), end);
});
test('TOTP RFC vectors, encrypted enrollment, replay rejection and session-bound proof', async () => {
  const vector = Buffer.from('12345678901234567890');
  for (const [time, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ] as const)
    assert.equal(totp(vector, Math.floor(time / 30)), expected);
  assert.equal(base32(Buffer.from('foo')), 'MZXW6');
  const store = new MemoryDocuments(),
    key = randomBytes(32).toString('base64url'),
    p = new FirestorePlatform(store),
    mfa = new AdminMfa(store, key),
    user = identity('admin');
  await p.grantAdmin('admin');
  const enrollment = await mfa.enroll(user);
  assert(enrollment.secret);
  assert(
    !JSON.stringify(await store.get('admin_mfa/' + tokenHash(user.uid))).includes(
      enrollment.secret,
    ),
  );
  // Decode the known enrollment locally, just as an authenticator would.
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of enrollment.secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const code = totp(Buffer.from(bytes), Math.floor(Date.now() / 30000)),
    result = await mfa.verify(user, 'session-a', code);
  assert(await mfa.verified(user.uid, 'session-a', result.proof));
  assert(!(await mfa.verified(user.uid, 'session-b', result.proof)));
  await assert.rejects(() => mfa.verify(user, 'session-a', code), { code: 'MFA_CODE_INVALID' });
  await assert.rejects(() => mfa.enroll(user), { code: 'MFA_ALREADY_ENABLED' });
  await p.grantAdmin('admin', true);
  assert(!(await mfa.verified(user.uid, 'session-a', result.proof)));
});
test('Bearer API validates Firebase identity, exact CORS origin and rejects cookie-only access', async () => {
  const store = new MemoryDocuments(),
    p = new FirestorePlatform(store),
    config = { ...testConfig(), API_AUTH_MODE: 'bearer' as const };
  await p.grantAdmin('admin');
  const provider: IdentityProvider = {
    verifyIdToken: async (token) => {
      if (!token.startsWith('test-token:')) throw Error();
      return identity(token.slice(11));
    },
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => {
      throw Error();
    },
  };
  const server = createApp(config, p, provider, undefined, { onboarding: p.onboarding }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    const preflight = await fetch(url + '/api/me', {
      method: 'OPTIONS',
      headers: {
        Origin: config.APP_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-admin-mfa',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), config.APP_ORIGIN);
    const bad = await fetch(url + '/api/me', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(bad.status, 403);
    assert.equal(
      (
        await fetch(url + '/api/admin/accounts', {
          headers: { Cookie: 'blackout_session=test-session:admin' },
        })
      ).status,
      401,
    );
    const result = await fetch(url + '/api/admin/accounts', {
      headers: { Authorization: 'Bearer test-token:admin' },
    });
    assert.equal(result.status, 200);
    const denied = await fetch(url + '/api/admin/accounts', {
      headers: { Authorization: 'Bearer test-token:other' },
    });
    assert.equal(denied.status, 403);
    const mutation = await fetch(url + '/api/auth/session', {
      method: 'POST',
      headers: { Origin: config.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'test-token:admin' }),
    });
    assert.equal(mutation.status, 200);
    assert.equal(mutation.headers.getSetCookie().length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
