import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { botTransaction } from '../server/bot-data.js';
import { SecretVault } from '../server/secret-vault.js';
import { reserveShared, consumeShared, restoreShared } from '../server/resale-stock.js';
import { creditProof } from '../server/resale-finance.js';
test('Two reseller stores cannot reserve the same last central unit and cancelling restores only to its origin', async () => {
  const store = new MemoryDocuments(),
    vault = new SecretVault(randomBytes(32).toString('base64url')),
    pid = 'abcdef123456',
    supplier = 'source';
  const products = ['first', 'second'].map((id) => ({
    id,
    title: id,
    description: '',
    category: 'Global',
    enabled: true,
    price: 1000,
    stock: 1,
    resale_source: { supplierId: supplier, productId: pid },
  }));
  await store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + supplier, { access_status: 'approved' });
    tx.set('bot_shops/' + supplier, { products: [{ id: pid, enabled: true, stock: 1 }] });
    tx.set('bot_shops/' + supplier + '/products/' + pid, {
      units: [
        {
          id: 'only',
          ciphertext: vault.seal(
            JSON.stringify({ kind: 'text', text: 'CENTRAL_SECRET' }),
            'source:stock:' + pid + ':only',
          ),
        },
      ],
    });
    for (const p of products) {
      tx.set('resale_profiles/' + p.id, { products: 'approved' });
      tx.set('resale_suppliers/' + supplier + '/grants/' + p.id + '_' + pid, {
        enabled: true,
        baseCents: 500,
      });
    }
  });
  const results = await Promise.allSettled(
    products.map((p) =>
      botTransaction(store, async (tx) => {
        const item = await reserveShared(tx, p.id, p, 1, vault);
        await consumeShared(tx, item);
        return item;
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const index = results.findIndex((r) => r.status === 'fulfilled'),
    item = (results[index] as PromiseFulfilledResult<any>).value;
  assert.equal((await store.get('bot_shops/source/products/' + pid))!.units.length, 0);
  assert.equal(
    JSON.parse(
      vault.open(
        item.units[0].ciphertext,
        products[index].id + ':stock:' + products[index].id + ':' + item.units[0].id,
      ),
    ).text,
    'CENTRAL_SECRET',
  );
  await botTransaction(store, (tx) => restoreShared(tx, item));
  assert.equal((await store.get('bot_shops/source/products/' + pid))!.units.length, 1);
});
test('Commission proof rejects wrong ledgers and invalid financial fields and flags incomplete base allocation', () => {
  const snapshot = {
      kind: 'plan' as const,
      partnerId: 'partner',
      generation: 'generation',
      subaccount: 'sacc_partner',
      baseCents: 999,
    },
    payment = { paymentId: 'psc_test', amountCents: 1999 };
  assert.throws(() => creditProof(snapshot, payment, { subaccountId: 'wrong', transactions: [] }), {
    code: 'RESALE_LEDGER_MISMATCH',
  });
  assert.equal(
    creditProof(snapshot, payment, { subaccountId: 'sacc_partner', transactions: [] }),
    null,
  );
  const ledger = {
    subaccountId: 'sacc_partner',
    transactions: [{ refId: 'psc_test', type: 'sale', amountCents: 930, feeCents: 999 }],
  };
  assert.equal(creditProof(snapshot, payment, ledger)!.status, 'credited');
  ledger.transactions[0].amountCents = 2000;
  assert.throws(() => creditProof(snapshot, payment, ledger), { code: 'RESALE_LEDGER_MISMATCH' });
  ledger.transactions[0].amountCents = 0;
  ledger.transactions[0].feeCents = 800;
  assert.equal(creditProof(snapshot, payment, ledger)!.status, 'review_required');
});
