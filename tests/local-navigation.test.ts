import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { localNavigation, type NavigationSnapshot } from '../server/local-navigation.js';
import { BotStore } from '../server/bot-store.js';
import { MemoryDocuments } from './document-memory.js';
import type { TelegramUpdate } from '../server/bot-types.js';

const id = '00000000-0000-4000-8000-000000000001';
const snapshot: NavigationSnapshot = {
  accountId: id,
  expiresAt: 60000,
  ownerId: '1',
  shop: {
    title: 'Loja',
    welcome: 'Olá',
    banner: '',
    support: '@support',
    payment_mode: 'manual',
    category_emojis: { Digital: '🎮' },
    products: [
      {
        id: 'a'.repeat(12),
        title: 'Produto',
        description: 'Descrição',
        category: 'Digital',
        price: 999,
        stock: 2,
        enabled: true,
      },
    ],
  },
};
const update = (cmd: string, user = 2): TelegramUpdate => ({
  update_id: 10,
  callback_query: {
    id: 'callback',
    from: { id: user },
    data: cmd,
    message: { message_id: 8, chat: { id: user, type: 'private' } },
  },
});

test('Buyer catalog renders locally with category emoji and edits the current screen', () => {
  const effects = localNavigation(snapshot, update('catalog'), 1)!;
  assert.equal(effects[1].method, 'editMessageText');
  assert.match(JSON.stringify(effects), /🎮 Digital/);
  assert.equal(
    effects.some((e) => JSON.stringify(e.payload).includes('admin')),
    false,
  );
});
test('Product actions point back to central checkout; out of stock offers notifications', () => {
  const effects = localNavigation(snapshot, update('p:' + 'a'.repeat(12)), 1)!;
  assert.match(JSON.stringify(effects), /buy:aaaaaaaaaaaa/);
  assert.match(JSON.stringify(effects), /add:aaaaaaaaaaaa/);
  const empty = structuredClone(snapshot);
  empty.shop.products[0].stock = 0;
  assert.match(
    JSON.stringify(localNavigation(empty, update('p:' + 'a'.repeat(12)), 1)),
    /watch-on:/,
  );
  assert.doesNotMatch(
    JSON.stringify(localNavigation(empty, update('p:' + 'a'.repeat(12)), 1)),
    /buy:/,
  );
});
test('Expired authorization, owner commands, carts and all financial actions use the central path', () => {
  assert.equal(localNavigation(snapshot, update('catalog'), 60000), null);
  assert.equal(localNavigation(snapshot, update('catalog', 1), 1), null);
  for (const cmd of [
    'admin',
    'checkout',
    'cart',
    'orders',
    'buy:aaaaaaaaaaaa',
    'add:aaaaaaaaaaaa',
    'pix-check:aaaaaaaaaaaaaaaa',
    'admin:wallet',
  ])
    assert.equal(localNavigation(snapshot, update(cmd), 1), null);
  const group = update('catalog');
  group.callback_query!.message!.chat.type = 'group';
  assert.equal(localNavigation(snapshot, group, 1), null);
  assert.equal(
    localNavigation(
      snapshot,
      {
        update_id: 2,
        message: { message_id: 2, chat: { id: 2, type: 'private' }, text: '/start confirm_key' },
      },
      1,
    ),
    null,
  );
});
test('Snapshot endpoint is pilot-only, strips private stock/payment data and checks suspension and runtime generation', async () => {
  const store = new MemoryDocuments();
  await store.transaction(async (tx) => {
    tx.set('bot_runtimes/' + id, { generation: 'g1', bot_id: 'bot' });
    tx.set('merchant_accounts/' + id, {
      firebase_uid: 'uid',
      purchase_confirmed_at: new Date(),
      access_status: 'approved',
      paid_through: new Date(90000),
    });
    tx.set('merchant_bot_setup/' + id, {
      submitted_at: new Date(),
      activation_status: 'active',
      bot_id: 'bot',
    });
    tx.set('bot_shops/' + id, {
      ...snapshot.shop,
      owner_id: '1',
      pix_keys: [{ value: 'private-pix' }],
      products: [{ ...snapshot.shop.products[0], units: [{ ciphertext: 'secret-unit' }] }],
    });
  });
  const bots = new BotStore(store, randomBytes(32).toString('base64url'), () => new Date(1000));
  const auth = { accountId: id, generation: 'g1' };
  assert.equal(await bots.navigationSnapshot(auth), null);
  bots.localNavigationPilotAccountId = id;
  const result = await bots.navigationSnapshot(auth);
  assert.equal(result?.expiresAt, 61000);
  assert.doesNotMatch(JSON.stringify(result), /secret-unit|private-pix|firebase_uid|ciphertext/);
  await assert.rejects(bots.navigationSnapshot({ ...auth, generation: 'wrong' }));
  await store.transaction(async (tx) => {
    const account = (await tx.get('merchant_accounts/' + id))!;
    tx.set('merchant_accounts/' + id, { ...account, access_status: 'suspended' });
  });
  assert.equal(await bots.navigationSnapshot(auth), null);
});
