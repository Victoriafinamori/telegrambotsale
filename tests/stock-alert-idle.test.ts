import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { queueStockAlerts } from '../server/stock-alerts.js';
import { SecretVault } from '../server/secret-vault.js';

test('Stock alert maintenance skips all writes when no buyers are waiting', async () => {
  const store = new MemoryDocuments();
  await store.transaction(async (tx) => {
    tx.set('bot_runtimes/shop', { generation: 'generation-1', stock_watch_cursor: '' });
  });
  store.transaction = async () => {
    throw Error('Idle maintenance must not start a transaction');
  };
  await queueStockAlerts(
    store,
    new SecretVault(randomBytes(32).toString('base64url')),
    { accountId: 'shop', generation: 'generation-1' },
    new Date(),
  );
  assert.equal((await store.get('bot_runtimes/shop'))?.stock_watch_cursor, '');
});
