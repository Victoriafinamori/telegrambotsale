import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { LocalShopStore } from '../server/local-shop-store.js';
import { LocalShopEditor } from '../server/local-shop-editor.js';
import { LocalUpdateCursor } from '../server/local-update-cursor.js';
import { localNavigation, type NavigationSnapshot } from '../server/local-navigation.js';
import { BotStore } from '../server/bot-store.js';
import { MemoryDocuments } from './document-memory.js';
import type { TelegramUpdate } from '../server/bot-types.js';

const id = '00000000-0000-4000-8000-000000000001';
const snapshot: NavigationSnapshot = {
  accountId: id,
  expiresAt: 60000,
  ownerId: '1',
  ownerVerified: true,
  generation: 'g1',
  revision: 'a'.repeat(64),
  ownerHasCentralSession: false,
  shop: {
    title: 'Loja',
    welcome: 'Olá',
    banner: 'photo',
    support: '',
    payment_mode: 'manual',
    products: [
      {
        id: 'b'.repeat(12),
        title: 'Produto',
        description: 'Original',
        category: 'Digital',
        price: 999,
        stock: 2,
        enabled: true,
      },
    ],
  },
};
let updateId = 0;
const text = (value: string, user = 1): TelegramUpdate => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    from: { id: user },
    chat: { id: user, type: 'private' },
    text: value,
  },
});
const click = (value: string, user = 1): TelegramUpdate => ({
  update_id: ++updateId,
  callback_query: {
    id: String(updateId),
    from: { id: user },
    data: value,
    message: { message_id: 5, chat: { id: user, type: 'private' } },
  },
});

test('Local start includes banner caption; administrative buttons are owner-only and deep links stay central', () => {
  const buyer = localNavigation(snapshot, text('/start', 2), 1, true)!;
  assert.equal(buyer[0].method, 'sendPhoto');
  assert.match(String(buyer[0].payload.caption), /Olá/);
  assert.doesNotMatch(JSON.stringify(buyer), /lc:menu|admin:wallet/);
  assert.match(JSON.stringify(localNavigation(snapshot, text('/start'), 1, true)), /lc:menu/);
  assert.equal(localNavigation(snapshot, text('/start confirm_secret'), 1, true), null);
  assert.equal(
    localNavigation({ ...snapshot, ownerVerified: false }, text('/start'), 1, true),
    null,
  );
  assert.equal(localNavigation(snapshot, text('/start'), 60000, true), null);
  assert.equal(
    localNavigation({ ...snapshot, ownerHasCentralSession: true }, text('/start'), 1, true),
    null,
  );
});

test('Menus, draft and preview perform zero central calls; save retries preserve the same mutation across editor restart', async () => {
  const store = new LocalShopStore(':memory:', id, randomBytes(32).toString('base64url'));
  const commands: unknown[] = [];
  const commit = async (command: unknown) => {
    commands.push(command);
    if (commands.length === 1) throw Error('lost response');
    return { snapshot };
  };
  try {
    let editor = new LocalShopEditor(store, id, commit, () => 1);
    editor.install(snapshot);
    assert.match(JSON.stringify(await editor.handle(text('/configurar'))), /Personalizar loja/);
    const field = await editor.handle(click('lc:field:welcome'));
    assert.equal(field?.[1].method, 'editMessageText');
    assert.match(JSON.stringify(await editor.handle(text('Nova mensagem'))), /Salvar alteração/);
    assert.equal(commands.length, 0);
    assert.match(JSON.stringify(await editor.handle(click('lc:save'))), /rascunho foi preservado/);
    editor = new LocalShopEditor(store, id, commit, () => 1);
    editor.install(snapshot);
    assert.match(JSON.stringify(await editor.handle(click('lc:save'))), /Alteração salva/);
    assert.deepEqual(commands[0], commands[1]);
    await editor.handle(click('lc:save'));
    assert.equal(commands.length, 2);
  } finally {
    await store.close();
  }
});

test('Local editor refuses buyers, expired permissions, central wizard input and clears draft on central commands', async () => {
  const store = new LocalShopStore(':memory:', id, randomBytes(32).toString('base64url'));
  let calls = 0;
  const editor = new LocalShopEditor(
    store,
    id,
    async () => {
      calls++;
      return { snapshot };
    },
    () => 1,
  );
  try {
    editor.install(snapshot);
    assert.equal(await editor.handle(text('/configurar', 2)), null);
    await editor.handle(click('lc:field:welcome'));
    assert.equal(await editor.handle(text('/admin')), null);
    assert.equal(await editor.handle(text('Não é rascunho')), null);
    editor.install({ ...snapshot, ownerHasCentralSession: true });
    assert.equal(await editor.handle(text('Unidade do estoque')), null);
    assert.match(JSON.stringify(await editor.handle(text('/configurar'))), /etapa em andamento/);
    editor.install({ ...snapshot, expiresAt: 1 });
    assert.equal(await editor.handle(click('lc:save')), null);
    editor.invalidate();
    assert.equal(await editor.handle(text('/configurar')), null);
    assert.equal(calls, 0);
  } finally {
    await store.close();
  }
});

test('Local update offset survives worker restart without replay and rejects old runtime, other bot or expired cursor', async () => {
  const store = new LocalShopStore(':memory:', id, randomBytes(32).toString('base64url'));
  try {
    const cursor = new LocalUpdateCursor(store, id, 'bot', 'g1', () => 1000);
    assert.equal(await cursor.resume(4), 4);
    await cursor.advance(10);
    assert.equal(await new LocalUpdateCursor(store, id, 'bot', 'g1', () => 2000).resume(4), 10);
    assert.equal(await cursor.resume(20), 20);
    assert.equal(await new LocalUpdateCursor(store, id, 'bot', 'g2', () => 2000).resume(4), 4);
    assert.equal(await new LocalUpdateCursor(store, id, 'other', 'g1', () => 2000).resume(4), 4);
    assert.equal(
      await new LocalUpdateCursor(store, id, 'bot', 'g1', () => 7 * 86400000).resume(4),
      4,
    );
  } finally {
    await store.close();
  }
});

async function fixture() {
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
      telegram_user_id: '1',
    });
    tx.set('bot_shops/' + id, {
      ...snapshot.shop,
      owner_id: '1',
      owner_bot_id: 'bot',
      portal_revision: 0,
    });
  });
  const bots = new BotStore(store, randomBytes(32).toString('base64url'), () => new Date(1000));
  bots.localNavigationPilotAccountId = id;
  const auth = { accountId: id, generation: 'g1' };
  const current = (await bots.navigationSnapshot(auth))!;
  const command = {
    mutationId: randomUUID(),
    ownerId: '1',
    generation: 'g1',
    revision: current.revision!,
    change: { kind: 'welcome' as const, value: 'Nova mensagem' },
  };
  return { store, bots, auth, command };
}

test('Central commit applies once, ignores stock-only changes, and rejects changed replay payload or stale configuration', async () => {
  const { store, bots, auth, command } = await fixture();
  await store.transaction(async (tx) => {
    const shop = (await tx.get('bot_shops/' + id))!;
    shop.products[0].stock = 1;
    tx.set('bot_shops/' + id, shop);
  });
  await bots.commitLocalConfiguration(auth, command);
  await bots.commitLocalConfiguration(auth, command);
  const shop = (await store.get('bot_shops/' + id))!;
  assert.equal(shop.welcome, 'Nova mensagem');
  assert.equal(shop.portal_revision, 1);
  assert.equal(shop.products[0].stock, 1);
  await assert.rejects(
    bots.commitLocalConfiguration(auth, {
      ...command,
      change: { kind: 'welcome', value: 'Outra' },
    }),
    /Atualize/,
  );
  await assert.rejects(
    bots.commitLocalConfiguration(auth, { ...command, mutationId: randomUUID() }),
    /outro lugar/,
  );
});

test('Central commit enforces runtime, owner, current permission and input scope; active central wizard cannot be overwritten', async () => {
  const { store, bots, auth, command } = await fixture();
  await assert.rejects(bots.commitLocalConfiguration({ ...auth, generation: 'wrong' }, command));
  await assert.rejects(bots.commitLocalConfiguration(auth, { ...command, ownerId: '2' }));
  await assert.rejects(
    bots.commitLocalConfiguration(auth, {
      ...command,
      change: { kind: 'welcome', value: 'Olá', payment_mode: 'manual' },
    }),
  );
  await store.transaction(async (tx) =>
    tx.set('bot_shops/' + id + '/customers/1', { session: { kind: 'stock' } }),
  );
  await assert.rejects(bots.commitLocalConfiguration(auth, command), /etapa em andamento/);
  await store.transaction(async (tx) => {
    tx.delete('bot_shops/' + id + '/customers/1');
    const account = (await store.get('merchant_accounts/' + id))!;
    tx.set('merchant_accounts/' + id, { ...account, access_status: 'suspended' });
  });
  await assert.rejects(bots.commitLocalConfiguration(auth, command));
  assert.equal((await store.get('bot_shops/' + id))?.welcome, 'Olá');
});

test('Global resale price edits preserve the supplier cost and cannot remove the source binding', async () => {
  const { store, bots, auth, command } = await fixture();
  const sourceId = 'c'.repeat(12),
    supplierId = 'supplier';
  await store.transaction(async (tx) => {
    const shop = (await tx.get('bot_shops/' + id))!;
    shop.products[0].resale_source = { supplierId, productId: sourceId };
    tx.set('bot_shops/' + id, shop);
    tx.set('resale_platform/settings', { supplier_id: supplierId });
    tx.set('resale_profiles/' + id, { products: 'approved' });
    tx.set('merchant_accounts/' + supplierId, { access_status: 'approved' });
    tx.set('bot_shops/' + supplierId, {
      products: [{ ...snapshot.shop.products[0], id: sourceId, price: 899 }],
    });
  });
  const price = {
    ...command,
    change: { kind: 'product_price', productId: 'b'.repeat(12), value: 899 },
  };
  await assert.rejects(bots.commitLocalConfiguration(auth, price), /maior que o custo/);
  await bots.commitLocalConfiguration(auth, { ...price, change: { ...price.change, value: 1600 } });
  const shop = (await store.get('bot_shops/' + id))!;
  assert.equal(shop.products[0].price, 1600);
  assert.deepEqual(shop.products[0].resale_source, { supplierId, productId: sourceId });
  assert.equal((await store.get('bot_shops/' + supplierId))?.products[0].price, 899);
});
