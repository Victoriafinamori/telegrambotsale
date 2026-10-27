import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MemoryDocuments } from './document-memory.js';
import { AdminHealth } from '../server/admin-health.js';
import { FirestorePlatform, adminPath } from '../server/firestore-platform.js';
import { BotStore } from '../server/bot-store.js';
import { createApp } from '../server/app.js';
import { testConfig } from './helpers.js';
const now = new Date('2026-10-27T12:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000);
async function fixture() {
  const store = new MemoryDocuments(),
    id = randomUUID();
  const write = (values: Record<string, Record<string, unknown>>) =>
    store.transaction(async (tx) => {
      for (const [path, value] of Object.entries(values)) tx.set(path, value);
    });
  await write({
    ['merchant_accounts/' + id]: {
      id,
      store_name: 'Test store',
      access_status: 'approved',
      paid_through: new Date(now.getTime() + 86400000),
      firebase_uid: 'merchant',
      private_field: 'PRIVATE_SENTINEL',
    },
    ['merchant_bot_setup/' + id]: {
      bot_id: '123',
      bot_username: 'TestStoreBot',
      telegram_user_id: '456',
      activation_status: 'active',
      submitted_at: ago(10),
    },
    ['bot_runtimes/' + id]: {
      bot_id: '123',
      last_seen: ago(1),
      revoked: false,
      secret_hash: 'PRIVATE_SENTINEL',
    },
    ['bot_shops/' + id]: { open_orders: [] },
  });
  return { id, store, write, service: new AdminHealth(store, () => now) };
}
test('Health distinguishes fresh heartbeat, missing contact, revoked runtime and deliberate access suspension', async () => {
  const f = await fixture();
  assert.equal((await f.service.read({})).rows[0].connection, 'online');
  await f.write({ ['bot_runtimes/' + f.id]: { bot_id: '123', last_seen: ago(2) } });
  let row = (await f.service.read({})).rows[0];
  assert.equal(row.connection, 'offline');
  assert(row.alerts.some((a) => a.kind === 'connection'));
  await f.write({ ['bot_runtimes/' + f.id]: { bot_id: 'OTHER', last_seen: now } });
  assert.equal((await f.service.read({})).rows[0].connection, 'mismatch');
  await f.write({ ['bot_runtimes/' + f.id]: { bot_id: '123', revoked: true, last_seen: now } });
  assert.equal((await f.service.read({})).rows[0].connection, 'revoked');
  const account = (await f.store.get('merchant_accounts/' + f.id))!;
  await f.write({ ['merchant_accounts/' + f.id]: { ...account, access_status: 'suspended' } });
  row = (await f.service.read({})).rows[0];
  assert(!row.alerts.some((a) => a.kind === 'connection'));
  assert(row.alerts.some((a) => a.kind === 'access'));
});
test('Payment waiting is separate from uncertain charges, manual receipts and unresolved delivery results', async () => {
  const f = await fixture(),
    root = 'bot_shops/' + f.id;
  await f.write({
    [root + '/orders/1111111111111111']: {
      id: '1111111111111111',
      status: 'awaiting_payment',
      payment_method: 'purincash',
      expires_at: new Date(now.getTime() + 60000),
      created_at: ago(5),
      total: 1000,
    },
    [root + '/orders/2222222222222222']: {
      id: '2222222222222222',
      status: 'paid',
      created_at: ago(10),
      receipt_ciphertext: 'PRIVATE_SENTINEL',
    },
    [root + '/orders/3333333333333333']: {
      id: '3333333333333333',
      status: 'awaiting_review',
      created_at: ago(5),
    },
    [root + '/orders/4444444444444444']: {
      id: '4444444444444444',
      status: 'refunded',
      created_at: ago(5),
    },
    [root + '/effects/failed']: {
      id: 'failed',
      status: 'failed',
      delivery: true,
      order_id: '2222222222222222',
      payload_ciphertext: 'PRIVATE_SENTINEL',
    },
    [root + '/effects/stale']: {
      id: 'stale',
      status: 'uncertain',
      delivery: true,
      order_id: '4444444444444444',
    },
    [`merchant_payment_secrets/${f.id}/purin_payments/1111111111111111`]: {
      state: 'uncertain',
      token: 'PRIVATE_SENTINEL',
    },
  });
  const result = await f.service.read({}),
    row = result.rows[0];
  assert.equal(row.counts.waitingPayment, 1);
  assert.equal(row.counts.manualReview, 1);
  assert.equal(row.counts.paymentIssues, 1);
  assert.equal(row.counts.deliveryIssues, 1);
  assert(row.alerts.some((a) => a.title === 'Falha na entrega'));
  assert(!row.alerts.some((a) => a.reference === '4444444444444444'));
  assert(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});
test('Activation exceptions and paused hosting are visible; checkout invoices stay separate from store sales', async () => {
  const f = await fixture();
  const setup = (await f.store.get('merchant_bot_setup/' + f.id))!;
  await f.write({
    ['merchant_bot_setup/' + f.id]: { ...setup, activation_status: 'configuring' },
    ['bot_activation_jobs/' + f.id]: {
      provider: 'hyze',
      stage: 'action_required',
      error_code: 'INSUFFICIENT_MEMORY',
      runtime_key_ciphertext: 'PRIVATE_SENTINEL',
    },
    'platform_hosting/hyze': { enabled: false, ciphertext: 'PRIVATE_SENTINEL' },
    'platform_subscription_invoices/invoice': {
      id: 'invoice',
      purpose: 'initial',
      status: 'uncertain',
      total: 999,
      created_at: now,
      qr_ciphertext: 'PRIVATE_SENTINEL',
    },
  });
  const result = await f.service.read({});
  assert.equal(result.hosting.enabled, false);
  assert.equal(result.hosting.connected, true);
  assert(result.rows[0].activationPending);
  assert(result.rows[0].alerts.some((a) => a.detail === 'Motivo: INSUFFICIENT_MEMORY'));
  assert.equal(result.billing[0].purpose, 'Contratação');
  assert.equal(result.billing[0].attention, true);
  assert.equal(result.summary.pendingPayments, 0);
  assert(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});
test('Health pagination is bounded and reports incomplete samples instead of claiming a complete audit', async () => {
  const f = await fixture();
  for (let index = 0; index < 11; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await f.write({
      ['merchant_accounts/' + id]: { id, store_name: 'Store ' + index, access_status: 'pending' },
    });
  }
  const first = await f.service.read({});
  assert.equal(first.rows.length, 10);
  assert(first.next);
  const second = await f.service.read({ after: first.next });
  assert.equal(second.rows.length, 2);
  assert(!second.rows.some((a) => first.rows.some((b) => a.id === b.id)));
  for (let index = 0; index < 26; index++)
    await f.write({
      [`bot_shops/${f.id}/orders/${String(index).padStart(16, '0')}`]: {
        id: String(index).padStart(16, '0'),
        status: 'delivered',
        created_at: now,
      },
    });
  const sample = await f.service.read({ after: '00000000-0000-4000-8000-000000000010' });
  assert.equal(sample.rows.find((row) => row.id === f.id)!.limited, true);
  await assert.rejects(() => f.service.read({ after: '../../secrets' }));
});
test('Health HTTP requires platform admin and confirmed second factor; endpoint performs no provider actions', async () => {
  const f = await fixture(),
    key = randomBytes(32).toString('base64url');
  await f.write({ [adminPath('admin')]: { firebase_uid: 'admin' } });
  const platform = new FirestorePlatform(f.store, key),
    bots = new BotStore(f.store, key);
  const config = {
    ...testConfig(),
    PLATFORM_DATABASE: 'firestore' as const,
    API_AUTH_MODE: 'bearer' as const,
    BOT_TOKEN_ENCRYPTION_KEY: key,
    ADMIN_MFA_REQUIRED: true,
  };
  const auth = {
    verifyIdToken: async (token: string) => ({
      uid: token === 'admin-mfa' ? 'admin' : token,
      email: 'example@test.invalid',
      emailVerified: true,
      authTime: Date.now() / 1000,
      secondFactor: token === 'admin-mfa',
    }),
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(config, platform, auth, undefined, {
    onboarding: platform.onboarding,
    bots,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = (user?: string) =>
    fetch(origin + '/api/admin/health', {
      headers: user ? { Authorization: 'Bearer ' + user, Origin: config.APP_ORIGIN } : {},
    });
  try {
    assert.equal((await request()).status, 401);
    assert.equal((await request('merchant')).status, 403);
    assert.equal((await request('admin')).status, 403);
    const result = await request('admin-mfa');
    assert.equal(result.status, 200);
    assert.equal((await result.json()).rows.length, 1);
    const details = await fetch(origin + '/api/admin/health/stores/' + f.id, {
      headers: { Authorization: 'Bearer admin-mfa', Origin: config.APP_ORIGIN },
    });
    assert.equal(details.status, 200);
    assert(!(await details.text()).includes('PRIVATE_SENTINEL'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
