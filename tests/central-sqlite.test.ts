import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SqliteDocumentStore } from '../server/sqlite-document-store.js';
import { migrateCentral } from '../server/central-migration.js';
import { loadConfig } from '../server/config.js';

const key = () => randomBytes(32).toString('base64url');
test('Transaction queries share their snapshot while unrelated reads wait for commit', async () => {
  const store = new SqliteDocumentStore(':memory:', 'platform:test', key());
  let unblock!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (unblock = resolve));
  try {
    const writing = store.transaction(async (tx) => {
      tx.set('orders/a', { id: 'a', status: 'paid' });
      assert.equal((await store.list('orders', { limit: 10 })).length, 1);
      entered();
      await gate;
    });
    await ready;
    let completed = false;
    const external = store.get('orders/a').then((doc) => {
      completed = true;
      return doc;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    unblock();
    await writing;
    assert.equal((await external)?.status, 'paid');
    await store.transaction(async () => {
      await assert.rejects(
        store.transaction(async () => {}),
        /Nested transactions/,
      );
    });
  } finally {
    unblock?.();
    await store.close();
  }
});
test('Central migration preserves dates, encrypted payloads, nested grants and scope without using Firestore', async () => {
  const target = new SqliteDocumentStore(':memory:', 'platform:test', key());
  const paid = new Date('2026-11-03T12:00:00Z');
  async function* source() {
    yield { path: 'merchant_accounts/shop', value: { id: 'shop', paid_through: paid } };
    yield {
      path: 'resale_suppliers/source/grants/shop_product',
      value: { enabled: true, baseCents: 899 },
    };
    yield {
      path: 'bot_shops/shop/orders/order',
      value: { id: 'order', status: 'paid', secret: 'encrypted-original' },
    };
  }
  try {
    const result = await migrateCentral(source(), target, 'test', true);
    assert.equal(result.total, 3);
    assert.equal(result.verified, true);
    assert.deepEqual((await target.get('merchant_accounts/shop'))?.paid_through, paid);
    assert.equal((await target.get('resale_suppliers/source/grants/shop_product'))?.baseCents, 899);
    assert.equal(
      (await target.list('bot_shops/shop/orders', { limit: 10, equals: ['status', 'paid'] }))
        .length,
      1,
    );
    await assert.rejects(migrateCentral(source(), target, 'test', true), /empty destination/);
  } finally {
    await target.close();
  }
});
test('Rehearsal and failed exports cannot produce a production-verified marker', async () => {
  const rehearsal = new SqliteDocumentStore(':memory:', 'platform:test', key());
  const failed = new SqliteDocumentStore(':memory:', 'platform:test', key());
  async function* source() {
    yield { path: 'accounts/a', value: { id: 'a' } };
  }
  async function* broken() {
    yield* source();
    throw Error('Quota exhausted');
  }
  try {
    assert.equal((await migrateCentral(source(), rehearsal, 'test')).verified, false);
    await assert.rejects(migrateCentral(broken(), failed, 'test', true));
    assert.equal(await failed.get('central_metadata/migration'), null);
  } finally {
    await rehearsal.close();
    await failed.close();
  }
});
test('Production SQLite requires its own encryption key and confirmed absolute persistent path', () => {
  const env = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://blackout-create.web.app',
    PLATFORM_DATABASE: 'sqlite',
    PLATFORM_SQLITE_PATH: '/data/blackout.sqlite',
    PLATFORM_SQLITE_ENCRYPTION_KEY: key(),
    SQLITE_DURABLE_STORAGE_CONFIRMED: 'true',
  };
  assert.equal(loadConfig(env).PLATFORM_DATABASE, 'sqlite');
  assert.throws(() => loadConfig({ ...env, SQLITE_DURABLE_STORAGE_CONFIRMED: 'false' }));
  assert.throws(() => loadConfig({ ...env, PLATFORM_SQLITE_PATH: 'relative.sqlite' }));
  assert.throws(() =>
    loadConfig({ ...env, BOT_TOKEN_ENCRYPTION_KEY: env.PLATFORM_SQLITE_ENCRYPTION_KEY }),
  );
});
