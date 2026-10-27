import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { StoreTest } from '../server/store-test.js';
import type { DocumentTransaction } from '../server/document-store.js';
import { createApp } from '../server/app.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { BotStore } from '../server/bot-store.js';
import { testConfig } from './helpers.js';
import { tokenHash } from '../server/accounts.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

class AuditedDocuments extends MemoryDocuments {
  writes: string[] = [];
  reads: string[] = [];
  override async transaction<T>(work: Parameters<MemoryDocuments['transaction']>[0]): Promise<T> {
    return super.transaction<T>((tx) =>
      work({
        get: (path) => {
          this.reads.push(path);
          return tx.get(path);
        },
        set: (path, value) => {
          this.writes.push(path);
          tx.set(path, value);
        },
        delete: (path) => {
          this.writes.push(path);
          tx.delete(path);
        },
      }),
    );
  }
}
const accountId = '00000000-0000-4000-8000-000000000001';
async function fixture(mode = 'manual', deliveryKind: 'file' | 'code' = 'code') {
  const store = new AuditedDocuments(),
    key = randomBytes(32).toString('base64url');
  let now = new Date();
  await store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + accountId, {
      id: accountId,
      firebase_uid: 'merchant',
      purchase_confirmed_at: new Date(),
      access_status: 'approved',
    });
    tx.set('platform_uids/' + tokenHash('merchant'), { account_id: accountId });
    tx.set('bot_shops/' + accountId, {
      title: 'Test shop',
      welcome: 'Welcome to this store',
      banner: '',
      support: '@merchantSupport',
      payment_mode: mode === 'stars' ? 'stars' : 'manual',
      pix_mode: mode,
      pix_keys: [{ value: 'REAL_PIX_KEY_SENTINEL' }],
      mp_connection: 'REAL_MP_CREDENTIAL',
      purin_connection: 'REAL_PURIN_CREDENTIAL',
      products: [
        {
          id: 'abcdef123456',
          title: 'Digital code',
          description: 'A test catalog product',
          category: 'Codes',
          enabled: true,
          price: 999,
          stock: 2,
          pix_qr: 'REAL_PIX_QR',
        },
        {
          id: 'abcdef123457',
          title: 'Sold out',
          description: 'No real stock',
          category: 'Codes',
          enabled: true,
          price: 599,
          stock: 0,
        },
      ],
      coupons: {},
      open_orders: ['REAL_ORDER'],
      recent_orders: ['REAL_ORDER'],
      stats: { orders: 7, delivered_orders: 6 },
      owner_id: 'REAL_OWNER',
    });
    tx.set(`bot_shops/${accountId}/products/abcdef123456`, {
      units: [{ id: 'REAL_UNIT', ciphertext: 'REAL_INVENTORY_SENTINEL' }],
    });
    tx.set(`bot_shops/${accountId}/orders/REAL_ORDER`, { status: 'delivered', total: 999 });
  });
  const originalShop = await store.get('bot_shops/' + accountId),
    originalStock = await store.get(`bot_shops/${accountId}/products/abcdef123456`);
  store.writes = [];
  store.reads = [];
  const service = new StoreTest(store, key, () => now);
  let session = await service.start(accountId, 'merchant', {
    requestId: randomUUID(),
    deliveryKind,
  });
  const act = async (action: string, value = '', messageId?: number) => {
    session = await service.action(accountId, 'merchant', {
      sessionId: session.id,
      revision: session.revision,
      requestId: randomUUID(),
      action,
      value,
      ...(messageId ? { messageId } : {}),
    });
    return session;
  };
  const click = async (value: string) => {
    const message = [...session.messages]
      .reverse()
      .find((m) => m.audience === 'buyer' && m.buttons.some((b) => b.data === value));
    assert(message, 'Expected customer button ' + value);
    return act('button', value, message.id);
  };
  const buy = async () => {
    await click('catalog');
    const category = session.messages
      .flatMap((m) => m.buttons)
      .find((b) => b.data.startsWith('cat:'))!;
    await click(category.data);
    await click('p:abcdef123456');
    await click('buy:abcdef123456');
  };
  return {
    store,
    key,
    service,
    originalShop,
    originalStock,
    act,
    click,
    buy,
    session: () => session,
    advance: () => {
      now = new Date(now.getTime() + 3 * 3600000);
    },
  };
}
test('Store simulation runs the actual buyer flow and delivers dummy codes without changing real stock, orders or stats', async () => {
  const f = await fixture();
  await f.buy();
  assert.equal(f.session().orders[0].status, 'awaiting_payment');
  assert.equal(f.session().products[0].stock, 1);
  await f.act('receipt');
  assert.equal(f.session().orders[0].status, 'awaiting_review');
  await f.act('approve');
  assert.equal(f.session().orders[0].status, 'delivered');
  assert(f.session().messages.some((m) => m.delivery && m.text.includes('BLACKOUT-TESTE-')));
  assert.deepEqual(await f.store.get('bot_shops/' + accountId), f.originalShop);
  assert.deepEqual(
    await f.store.get(`bot_shops/${accountId}/products/abcdef123456`),
    f.originalStock,
  );
  assert(f.store.writes.every((path) => path === 'merchant_test_sessions/' + accountId));
  assert(
    f.store.reads.every((path) =>
      [
        'merchant_accounts/' + accountId,
        'bot_shops/' + accountId,
        'merchant_test_sessions/' + accountId,
      ].includes(path),
    ),
  );
  const state = JSON.stringify(f.session());
  for (const secret of [
    'REAL_INVENTORY_SENTINEL',
    'REAL_PIX_KEY_SENTINEL',
    'REAL_MP_CREDENTIAL',
    'REAL_PURIN_CREDENTIAL',
    'REAL_ORDER',
  ])
    assert(!state.includes(secret));
});
test('Simulation rejects or cancels only the fictitious order and releases only its copied inventory', async () => {
  const f = await fixture();
  await f.buy();
  await f.act('reject');
  assert.equal(f.session().orders[0].status, 'rejected');
  assert.equal(f.session().products[0].stock, 2);
  assert.equal(f.session().messages.filter((m) => m.delivery).length, 0);
  await f.act('text', '/start');
  await f.buy();
  const order = f.session().orders.find((o) => o.status === 'awaiting_payment')!;
  await f.click('cancel:' + order.id);
  assert.equal(f.session().products[0].stock, 2);
  assert.deepEqual(await f.store.get('bot_shops/' + accountId), f.originalShop);
});
test('Purin, Mercado Pago and Stars simulate approvals locally with no HTTP request or financial provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error('A test must never call an external provider');
  };
  try {
    for (const mode of ['purincash', 'mercadopago', 'stars']) {
      const f = await fixture(mode, 'file');
      await f.buy();
      await f.act('approve');
      assert.equal(f.session().orders[0].status, 'delivered');
      assert(f.session().messages.some((m) => m.delivery && m.kind === 'file'));
      assert.equal(f.session().mode, mode);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('Test state survives a new service instance, is encrypted, expires, and rejects cross-store or stale requests', async () => {
  const f = await fixture();
  await f.buy();
  const next = new StoreTest(f.store, f.key);
  const restored = (await next.read(accountId, 'merchant')).session!;
  assert.equal(restored.id, f.session().id);
  assert.deepEqual(restored.orders, f.session().orders);
  assert(
    !JSON.stringify(await f.store.get('merchant_test_sessions/' + accountId)).includes(
      'Welcome to this store',
    ),
  );
  await assert.rejects(() => next.read(accountId, 'stranger'), { code: 'TEST_OWNER_REQUIRED' });
  await assert.rejects(
    () =>
      next.action(accountId, 'merchant', {
        sessionId: restored.id,
        revision: 0,
        requestId: randomUUID(),
        action: 'approve',
      }),
    { code: 'TEST_CHANGED' },
  );
  await assert.rejects(() =>
    next.action(accountId, 'merchant', {
      sessionId: restored.id,
      revision: restored.revision,
      requestId: randomUUID(),
      action: 'button',
      value: 'admin:wallet',
      messageId: 1,
    }),
  );
  f.advance();
  assert.equal((await f.service.read(accountId, 'merchant')).session, null);
  await assert.rejects(
    () =>
      f.service.action(accountId, 'merchant', {
        sessionId: restored.id,
        revision: restored.revision,
        requestId: randomUUID(),
        action: 'approve',
      }),
    { code: 'TEST_EXPIRED' },
  );
});
test('Replayed or concurrent approvals never duplicate even the fictitious delivery', async () => {
  const f = await fixture();
  await f.buy();
  const s = f.session();
  const request = {
    sessionId: s.id,
    revision: s.revision,
    requestId: randomUUID(),
    action: 'approve',
  };
  const [a, b] = await Promise.all([
    f.service.action(accountId, 'merchant', request),
    f.service.action(accountId, 'merchant', request),
  ]);
  assert.equal(a.messages.filter((m) => m.delivery).length, 1);
  assert.equal(b.messages.filter((m) => m.delivery).length, 1);
  assert.equal(a.revision, b.revision);
});
test('Sold-out products remain sold out; restocking the test copy does not replenish the live catalog', async () => {
  const f = await fixture();
  await f.act('restock', 'abcdef123457');
  assert.equal(f.session().products[1].stock, 1);
  assert.equal((await f.store.get('bot_shops/' + accountId))!.products[1].stock, 0);
});

test('Cart checkout and multiple open test orders keep the latest pending payment controls consistent', async () => {
  const f = await fixture();
  await f.click('catalog');
  const category = f.session().messages.flatMap(m => m.buttons).find(b => b.data.startsWith('cat:'))!;
  await f.click(category.data); await f.click('p:abcdef123456'); await f.click('add:abcdef123456');
  await f.click('cart'); await f.click('checkout');
  const first = f.session().orders[0].id;
  await f.act('text', '/start'); await f.buy();
  const second = f.session().orders[0].id;
  assert.notEqual(first, second);
  await f.act('approve');
  assert.equal(f.session().orders.find(o => o.id === second)!.status, 'delivered');
  assert.equal(f.session().orders.find(o => o.id === first)!.status, 'awaiting_payment');
  assert.equal(f.session().products[0].stock, 0);
  assert.deepEqual(await f.store.get('bot_shops/' + accountId), f.originalShop);
});
test('Simulation HTTP requires merchant identity and rejects caller-selected store ids', async () => {
  const f = await fixture(),
    platform = new FirestorePlatform(f.store, f.key),
    bots = new BotStore(f.store, f.key);
  const config = {
    ...testConfig(),
    PLATFORM_DATABASE: 'firestore' as const,
    API_AUTH_MODE: 'bearer' as const,
    BOT_TOKEN_ENCRYPTION_KEY: f.key,
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
  const headers = {
    Authorization: 'Bearer merchant',
    Origin: config.APP_ORIGIN,
    'Content-Type': 'application/json',
  };
  try {
    assert.equal((await fetch(origin + '/api/store/manage/test')).status, 401);
    assert.equal(
      (
        await fetch(origin + '/api/store/manage/test', {
          headers: { ...headers, Authorization: 'Bearer stranger' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(origin + '/api/store/manage/test?accountId=other', { headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/api/store/manage/test/start', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            accountId: 'other',
            requestId: randomUUID(),
            deliveryKind: 'code',
          }),
        })
      ).status,
      400,
    );
    await f.store.transaction(async (tx) => {
      const a = (await tx.get('merchant_accounts/' + accountId))!;
      tx.set('merchant_accounts/' + accountId, { ...a, access_status: 'suspended' });
    });
    assert.equal((await fetch(origin + '/api/store/manage/test', { headers })).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
