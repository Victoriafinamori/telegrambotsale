import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { botTransaction, botPath, botRoot } from '../server/bot-data.js';
import {
  StockPlanner,
  reserveBundle,
  changeBundle,
  syncBundles,
  validateBundle,
} from '../server/bundle-stock.js';
import { SecretVault } from '../server/secret-vault.js';
import type { Shop, Product } from '../server/bot-types.js';
const a = 'aaaaaaaaaaaa',
  b = 'bbbbbbbbbbbb',
  c = 'cccccccccccc';
async function fixture(na = 2, nb = 2) {
  const store = new MemoryDocuments(),
    vault = new SecretVault(randomBytes(32).toString('base64url'));
  const p = (id: string, title: string, stock: number): Product => ({
    id,
    title,
    stock,
    price: 999,
    description: title,
    category: 'Teste',
    enabled: true,
  });
  const shop = {
    products: [
      p(a, 'Netflix', na),
      p(b, 'Disney', nb),
      {
        ...p(c, 'Combo', 0),
        bundle: [
          { productId: a, quantity: 1 },
          { productId: b, quantity: 1 },
        ],
      },
    ],
    open_orders: [],
  } as unknown as Shop;
  syncBundles(shop);
  await store.transaction(async (tx) => {
    tx.set(botRoot('owner'), shop);
    for (const prod of shop.products) {
      tx.set(botPath('owner', 'products', prod.id), {
        id: prod.id,
        units: Array.from({ length: prod.bundle ? 0 : prod.stock }, (_, i) => ({
          id: 'unit' + i,
          ciphertext: vault.seal(
            JSON.stringify({ kind: 'text', text: prod.title + ' SECRET ' + i }),
            `owner:stock:${prod.id}:unit${i}`,
          ),
        })),
      });
    }
  });
  return { store, vault, shop };
}
test('Bundle availability follows the scarcest enabled component, required quantities and infinite modes', async () => {
  const { shop } = await fixture(10, 4);
  syncBundles(shop);
  assert.equal(shop.products[2].stock, 4);
  shop.products[2].bundle![0].quantity = 2;
  syncBundles(shop);
  assert.equal(shop.products[2].stock, 4);
  shop.products[0].stock = 3;
  syncBundles(shop);
  assert.equal(shop.products[2].stock, 1);
  shop.products[0].stock_mode = 'infinite';
  shop.products[0].stock = 1000000;
  syncBundles(shop);
  assert.equal(shop.products[2].stock, 4);
  shop.products[1].enabled = false;
  syncBundles(shop);
  assert.equal(shop.products[2].stock, 0);
});
test('A mixed cart cannot reserve the same unit for a standalone product and a bundle; failed plans leave all stock untouched', async () => {
  const { store, vault } = await fixture(1, 1);
  await assert.rejects(
    () =>
      botTransaction(store, async (tx) => {
        const shop = (await tx.get(botRoot('owner'))) as Shop;
        const planner = new StockPlanner(tx);
        await planner.take('owner', a, 1);
        await reserveBundle(tx, 'owner', 'owner', shop.products[2], 1, vault, planner);
      }),
    { code: 'BUNDLE_STOCK_EMPTY' },
  );
  for (const id of [a, b])
    assert.equal((await store.get(botPath('owner', 'products', id)))!.units.length, 1);
});
test('Reservation is atomic across concurrent buyers; cancellation restores the snapshotted components after recipe changes', async () => {
  const { store, vault } = await fixture(1, 1);
  const reserve = () =>
    botTransaction(store, async (tx) => {
      const shop = (await tx.get(botRoot('owner'))) as Shop;
      const item = await reserveBundle(
        tx,
        'owner',
        'owner',
        shop.products[2],
        1,
        vault,
        new StockPlanner(tx),
      );
      await changeBundle(tx, item, 'consume', 'owner', shop);
      tx.set(botRoot('owner'), shop);
      return item;
    });
  const results = await Promise.allSettled([reserve(), reserve()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const item = (
    results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof reserve>>
    >
  ).value;
  const delivered = item.units.map((u) =>
    JSON.parse(vault.open(u.ciphertext, `owner:stock:${c}:${u.id}`)),
  );
  assert.deepEqual(
    delivered.map((u) => u.componentTitle),
    ['Netflix', 'Disney'],
  );
  await botTransaction(store, async (tx) => {
    const shop = (await tx.get(botRoot('owner'))) as Shop;
    shop.products[2].bundle = [];
    await changeBundle(tx, item, 'restore', 'owner', shop);
    tx.set(botRoot('owner'), shop);
  });
  for (const id of [a, b])
    assert.equal((await store.get(botPath('owner', 'products', id)))!.units.length, 1);
});
test('Bundles reject duplicates, missing products, recursive recipes, nested combos and supplier-owned components', async () => {
  const { shop } = await fixture();
  for (const rows of [
    [
      { productId: a, quantity: 1 },
      { productId: a, quantity: 1 },
    ],
    [
      { productId: c, quantity: 1 },
      { productId: b, quantity: 1 },
    ],
    [
      { productId: 'dddddddddddd', quantity: 1 },
      { productId: b, quantity: 1 },
    ],
  ])
    assert.throws(() => validateBundle(shop, c, rows));
  assert.throws(() =>
    validateBundle(shop, a, [
      { productId: b, quantity: 1 },
      { productId: c, quantity: 1 },
    ]),
  );
  shop.products[0].resale_source = { supplierId: 'elsewhere', productId: a };
  assert.throws(() => validateBundle(shop, c, shop.products[2].bundle));
});

test('A combo can mix ghost quantities and infinite templates; reservations decrement only the finite component and cancellation restores it', async () => {
  const { store, vault } = await fixture(0, 0);
  await store.transaction(async (tx) => {
    const shop = (await tx.get(botRoot('owner'))) as Shop;
    for (const [id, mode] of [
      [a, 'ghost'],
      [b, 'infinite'],
    ]) {
      const stock = {
        mode,
        remaining: 4,
        units: [],
        template: {
          id: 'template',
          ciphertext: vault.seal(
            JSON.stringify({ kind: 'text', text: mode + ' RESGATE' }),
            `owner:stock:${id}:template`,
          ),
        },
      };
      tx.set(botPath('owner', 'products', id), stock);
      const p = shop.products.find((p) => p.id === id)!;
      p.stock_mode = mode as Product['stock_mode'];
      p.stock = mode === 'infinite' ? 1000000 : 4;
    }
    shop.products[2].bundle![0].quantity = 2;
    syncBundles(shop);
    tx.set(botRoot('owner'), shop);
  });
  const item = await botTransaction(store, async (tx) => {
    const shop = (await tx.get(botRoot('owner'))) as Shop;
    assert.equal(shop.products[2].stock, 2);
    const item = await reserveBundle(
      tx,
      'owner',
      'owner',
      shop.products[2],
      2,
      vault,
      new StockPlanner(tx),
    );
    assert.equal(item.units.length, 6);
    await changeBundle(tx, item, 'consume', 'owner', shop);
    tx.set(botRoot('owner'), shop);
    return item;
  });
  assert.equal((await store.get(botPath('owner', 'products', a)))!.remaining, 0);
  assert.equal((await store.get(botPath('owner', 'products', b)))!.remaining, 4);
  await botTransaction(store, async (tx) => {
    const shop = (await tx.get(botRoot('owner'))) as Shop;
    await changeBundle(tx, item, 'restore', 'owner', shop);
    tx.set(botRoot('owner'), shop);
  });
  assert.equal((await store.get(botPath('owner', 'products', a)))!.remaining, 4);
  assert.equal((await store.get(botRoot('owner')))!.products[2].stock, 2);
});
