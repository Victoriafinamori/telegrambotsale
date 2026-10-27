import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocuments } from './document-memory.js';
import { readSetupProgress } from '../server/setup-progress.js';
import { tokenHash } from '../server/accounts.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { BotStore } from '../server/bot-store.js';
import { createApp } from '../server/app.js';
import { testConfig } from './helpers.js';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const id = '00000000-0000-4000-8000-000000000001';
async function fixture() {
  const store = new MemoryDocuments();
  await store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + id, {
      id,
      firebase_uid: 'merchant',
      purchase_confirmed_at: new Date(),
      access_status: 'approved',
      paid_through: new Date(Date.now() + 86400000),
    });
    tx.set('platform_uids/' + tokenHash('merchant'), { account_id: id });
  });
  const patch = (path: string, value: Record<string, unknown>) =>
    store.transaction(async (tx) => {
      tx.set(path, { ...(await tx.get(path)), ...value });
    });
  const connect = async () => {
    await patch('merchant_bot_setup/' + id, {
      submitted_at: new Date(),
      activation_status: 'configuring',
      bot_id: '123456789',
      bot_username: 'BlackoutTestBot',
      telegram_user_id: '111111111',
    });
    await patch('bot_runtimes/' + id, {
      bot_id: '123456789',
      revoked: false,
      last_seen: new Date(),
    });
    await patch('bot_shops/' + id, {
      welcome: 'Escolha um produto.',
      products: [],
      payment_mode: 'manual',
      coupons: {},
      open_orders: [],
      recent_orders: [],
    });
  };
  const configured = async () => {
    await patch('bot_shops/' + id, {
      owner_id: '111111111',
      owner_bot_id: '123456789',
      support_phone: '11999999999',
      payment_instructions: 'Pix de teste',
      products: [
        {
          id: 'abcdef123456',
          category: 'Codes',
          title: 'Product',
          description: 'Test',
          price: 999,
          stock: 1,
          enabled: true,
        },
      ],
    });
    await patch('merchant_bot_setup/' + id, { activation_status: 'active' });
  };
  return {
    store,
    patch,
    connect,
    configured,
    read: () => readSetupProgress(store, id, 'merchant'),
  };
}
test('Configuration resumes from persisted payment, connected bot and Telegram owner across new service reads', async () => {
  const f = await fixture();
  let progress = await f.read();
  assert.equal(progress.steps.find((step) => step.state === 'current')!.id, 'bot');
  assert.equal(progress.completed, 1);
  await f.patch('merchant_bot_setup/' + id, {
    submitted_at: new Date(),
    activation_status: 'pending',
    bot_id: '123456789',
  });
  assert.equal((await f.read()).steps[1].state, 'current');
  await f.connect();
  progress = await readSetupProgress(f.store, id, 'merchant');
  assert.equal(progress.steps.find((step) => step.state === 'current')!.id, 'owner');
  assert.equal(progress.steps[2].action!.command, 'owner');
  await f.patch('bot_shops/' + id, { owner_id: '111111111', owner_bot_id: 'DIFFERENT_BOT' });
  assert.equal((await f.read()).steps[2].state, 'current');
  await f.patch('bot_shops/' + id, { owner_bot_id: '123456789' });
  assert.equal((await f.read()).steps.find((step) => step.state === 'current')!.id, 'store');
  await f.configured();
  progress = await readSetupProgress(f.store, id, 'merchant');
  assert(progress.ready);
  assert.equal(progress.completed, 5);
  assert.equal(progress.steps[4].action!.href, 'https://t.me/BlackoutTestBot');
});
test('Readiness requires real stock, support and payment; banner is optional and no read starts billing', async () => {
  const f = await fixture();
  await f.connect();
  await f.configured();
  const accountBefore = await f.store.get('merchant_accounts/' + id);
  assert((await f.read()).ready);
  await f.patch('bot_shops/' + id, { products: [{ enabled: true, stock: 0, price: 999 }] });
  let progress = await f.read();
  assert(!progress.ready);
  assert.equal(progress.steps[3].action!.href, '#/gestao?section=stock');
  await f.patch('bot_shops/' + id, { support_phone: '', payment_instructions: '' });
  progress = await f.read();
  assert.equal(progress.checks.find((check) => check.id === 'support')!.done, false);
  assert.equal(progress.checks.find((check) => check.id === 'payment')!.done, false);
  assert.deepEqual(await f.store.get('merchant_accounts/' + id), accountBefore);
});
test('Purin must match the platform credential and store subaccount; requesting activation alone is not completion', async () => {
  const f = await fixture();
  await f.connect();
  await f.configured();
  await f.patch('bot_shops/' + id, {
    pix_mode: 'purincash',
    purin_requested: true,
    purin_connection: 'generation',
    purin_subaccount: 'sacc_test',
  });
  assert.equal((await f.read()).checks[3].done, false);
  await f.patch('platform_payments/purincash', { generation: 'generation' });
  await f.patch('platform_payments/purincash/connections/generation', {
    ciphertext: 'PRIVATE_PROVIDER_TEST',
  });
  await f.patch('purin_subaccount_claims/sacc_test', { account_id: 'another-store' });
  assert.equal((await f.read()).checks[3].done, false);
  await f.patch('purin_subaccount_claims/sacc_test', { account_id: id });
  assert((await f.read()).ready);
  assert(!JSON.stringify(await f.read()).includes('PRIVATE_PROVIDER_TEST'));
  await f.patch('platform_payments/purincash', { generation: 'new-generation' });
  assert.equal((await f.read()).checks[3].done, false);
});
test('Mercado Pago readiness uses the store connection; Stars does not require a Pix key', async () => {
  const f = await fixture();
  await f.connect();
  await f.configured();
  await f.patch('bot_shops/' + id, { pix_mode: 'mercadopago', mp_connection: 'my-generation' });
  assert.equal((await f.read()).checks[3].done, false);
  await f.patch('merchant_payment_secrets/' + id + '/connections/my-generation', {
    ciphertext: 'PRIVATE_TEST',
  });
  assert((await f.read()).ready);
  await f.patch('bot_shops/' + id, { payment_mode: 'stars', payment_instructions: '' });
  assert((await f.read()).ready);
});
test('Offline, expired, suspended or revoked bot never reports a ready store', async () => {
  const f = await fixture();
  await f.connect();
  await f.configured();
  await f.patch('bot_runtimes/' + id, { last_seen: new Date(Date.now() - 120000) });
  assert.equal((await f.read()).steps[4].action!.command, 'refresh');
  await f.patch('bot_runtimes/' + id, { last_seen: new Date() });
  await f.patch('merchant_accounts/' + id, {
    billing_started_at: new Date(),
    paid_through: new Date(Date.now() - 1),
  });
  assert.equal((await f.read()).steps[4].action!.href, '#/minha-loja?subscription=1');
  await f.patch('merchant_accounts/' + id, { access_status: 'suspended' });
  assert((await f.read()).steps.every((step) => step.action === null));
  assert.equal((await f.read()).ready, false);
  await f.patch('merchant_accounts/' + id, {
    access_status: 'approved',
    paid_through: new Date(Date.now() + 86400000),
  });
  await f.patch('bot_runtimes/' + id, { revoked: true });
  assert.equal((await f.read()).steps[1].state, 'current');
  assert.equal((await f.read()).ready, false);
});
test('Progress HTTP derives store ownership from identity and exposes only the safe checklist', async () => {
  const f = await fixture();
  await f.connect();
  const key = randomBytes(32).toString('base64url'),
    platform = new FirestorePlatform(f.store, key),
    bots = new BotStore(f.store, key);
  const config = {
    ...testConfig(),
    PLATFORM_DATABASE: 'firestore' as const,
    API_AUTH_MODE: 'bearer' as const,
    BOT_TOKEN_ENCRYPTION_KEY: key,
  };
  const auth = {
    verifyIdToken: async (token: string) => ({
      uid: token,
      email: token + '@example.test',
      emailVerified: true,
      authTime: Date.now() / 1000,
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
  const request = (path: string, user?: string) =>
    fetch(origin + path, {
      headers: user ? { Authorization: 'Bearer ' + user, Origin: config.APP_ORIGIN } : {},
    });
  try {
    assert.equal((await request('/api/store/runtime')).status, 401);
    assert.equal((await request('/api/store/runtime', 'stranger')).status, 403);
    const result = await request('/api/store/runtime?accountId=another', 'merchant');
    assert.equal(result.status, 200);
    assert.equal((await result.json()).progress.steps[2].state, 'current');
    await assert.rejects(() => readSetupProgress(f.store, id, 'stranger'), {
      code: 'STORE_OWNER_REQUIRED',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
