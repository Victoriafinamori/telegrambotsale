import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalShopStore } from '../server/local-shop-store.js';

const id = '00000000-0000-4000-8000-000000000001';
const root = 'bot_shops/' + id;
test('Local shop persists encrypted stock and dates across restart and rejects other shops', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'blackout-local-'));
  const filename = join(folder, 'shop.sqlite'),
    key = randomBytes(32).toString('base64url');
  let store = new LocalShopStore(filename, id, key);
  try {
    const now = new Date();
    await store.transaction(async (tx) =>
      tx.set(root, { secret: 'private-stock-code-XYZ', date: now }),
    );
    await assert.rejects(store.get('merchant_accounts/' + id));
    await assert.rejects(store.get('bot_shops/another-shop'));
    await store.close();
    assert.equal((await readFile(filename)).includes(Buffer.from('private-stock-code-XYZ')), false);
    store = new LocalShopStore(filename, id, key);
    assert.deepEqual(await store.get(root), { secret: 'private-stock-code-XYZ', date: now });
    assert.throws(() => new LocalShopStore(filename, '00000000-0000-4000-8000-000000000002', key));
    assert.throws(() => new LocalShopStore(filename, id, randomBytes(32).toString('base64url')));
    const backup = join(folder, 'backup.sqlite');
    await store.backupTo(backup);
    const restored = new LocalShopStore(backup, id, key);
    assert.deepEqual(await restored.get(root), { secret: 'private-stock-code-XYZ', date: now });
    await restored.close();
  } finally {
    await store.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test('Local transactions roll back failed changes and serialize concurrent stock reservations', async () => {
  const store = new LocalShopStore(':memory:', id, randomBytes(32).toString('base64url'));
  try {
    await store.transaction(async (tx) => tx.set(root, { stock: 1 }));
    await assert.rejects(
      store.transaction(async (tx) => {
        tx.set(root, { stock: 99 });
        throw Error('Simulated failure');
      }),
    );
    const reserve = () =>
      store.transaction(async (tx) => {
        const item = (await tx.get(root))!;
        await Promise.resolve();
        if (!item.stock) return false;
        tx.set(root, { stock: item.stock - 1 });
        return true;
      });
    assert.deepEqual(await Promise.all([reserve(), reserve()]), [true, false]);
    assert.equal((await store.get(root))?.stock, 0);
  } finally {
    await store.close();
  }
});
test('Local collection queries isolate nested documents and support cursor, status and ordering', async () => {
  const store = new LocalShopStore(':memory:', id, randomBytes(32).toString('base64url'));
  try {
    await store.transaction(async (tx) => {
      for (const [id, price] of [
        ['a', 2],
        ['b', 3],
        ['c', 1],
      ] as const)
        tx.set(root + '/products/' + id, { id, price, enabled: id !== 'c' });
      tx.set(root + '/products/a/private/x', { id: 'nested' });
    });
    assert.deepEqual(
      (
        await store.list(root + '/products', {
          limit: 10,
          equals: ['enabled', true],
          orderBy: 'price',
        })
      ).map((x) => x.id),
      ['b', 'a'],
    );
    assert.deepEqual(
      (await store.list(root + '/products', { limit: 1, afterId: 'a' })).map((x) => x.id),
      ['b'],
    );
  } finally {
    await store.close();
  }
});
