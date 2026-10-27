import test from 'node:test';
import assert from 'node:assert/strict';
import { saleBreakdown, payoutBreakdown } from '../server/wallet-breakdown.js';
import { MemoryDocuments } from './document-memory.js';
import { PurinWallet } from '../server/purin-wallet.js';
import { SecretVault } from '../server/secret-vault.js';
import { randomBytes, randomUUID } from 'node:crypto';

test('Sales reconcile historical gross, gateway fee, Blackout markup and actual ledger credit', () => {
  assert.deepEqual(saleBreakdown({ amountCents: 850, feeCents: 100 }, 1000), {
    grossCents: 1000,
    netCents: 850,
    blackoutFeeCents: 100,
    gatewayFeeCents: 50,
    reconciled: true,
  });
  assert.equal(saleBreakdown({ amountCents: 950, feeCents: 0 }, 1000).gatewayFeeCents, 50);
});
test('Missing or inconsistent amounts are never presented as zero or estimated from current rates', () => {
  assert.equal(saleBreakdown({ amountCents: 950 }, 1000).gatewayFeeCents, null);
  assert.equal(saleBreakdown({ amountCents: 950 }, 1000).blackoutFeeCents, null);
  assert.equal(saleBreakdown({ amountCents: 950, feeCents: 0 }, undefined).grossCents, null);
  assert.equal(saleBreakdown({ amountCents: 1100, feeCents: 50 }, 1000).reconciled, false);
  assert.equal(saleBreakdown({ amountCents: '950', feeCents: 0 }, 1000).netCents, null);
});
test('Payout fields use provider semantics: feeCents is Blackout, platformFeeCents is Purin', () => {
  assert.deepEqual(
    payoutBreakdown({
      amountCents: 15000,
      feeCents: 350,
      platformFeeCents: 100,
      netAmountCents: 14550,
    }),
    { blackoutFeeCents: 350, gatewayFeeCents: 100, totalFeeCents: 450, netCents: 14550 },
  );
  assert.deepEqual(payoutBreakdown({ platformFeeCents: 100 }), {
    blackoutFeeCents: null,
    gatewayFeeCents: 100,
    totalFeeCents: null,
    netCents: null,
  });
});
test('Wallet joins only own subaccount sales and keeps signed ledger movements without sending financial writes', async () => {
  const store = new MemoryDocuments(),
    key = randomBytes(32).toString('base64url'),
    generation = randomUUID(),
    id = randomUUID(),
    subaccount = 'sacc_own';
  await store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + id, { firebase_uid: 'merchant', access_status: 'approved' });
    tx.set('merchant_bot_setup/' + id, { telegram_user_id: '12345', bot_id: '67890' });
    tx.set('bot_shops/' + id, {
      owner_id: '12345',
      owner_bot_id: '67890',
      purin_connection: generation,
      purin_subaccount: subaccount,
    });
    tx.set('platform_payments/purincash', { withdrawals_enabled: true });
    tx.set('platform_payments/purincash/connections/' + generation, {
      ciphertext: new SecretVault(key).seal(
        JSON.stringify({ token: 'PRIVATE_TEST_TOKEN' }),
        'purin:' + generation,
      ),
    });
    tx.set(`bot_shops/${id}/orders/own`, {
      id: 'own',
      purin_payment_id: 'psc_own',
      purin_subaccount: subaccount,
      payment_method: 'purincash',
      currency: 'BRL',
      total: 1000,
    });
    tx.set(`bot_shops/${id}/orders/foreign`, {
      id: 'foreign',
      purin_payment_id: 'psc_wrong',
      purin_subaccount: 'sacc_other',
      payment_method: 'purincash',
      currency: 'BRL',
      total: 999999,
    });
  });
  let mismatch = false;
  const wallet = new PurinWallet(store, key, 'https://example.test', async (url, init) => {
    assert.equal(init?.method, 'GET');
    if (String(url).includes('/transactions'))
      return Response.json({
        subaccountId: mismatch ? 'sacc_other' : subaccount,
        transactions: [
          { id: 'one', refId: 'psc_own', type: 'sale', amountCents: 850, feeCents: 100 },
          { id: 'two', refId: 'psc_wrong', type: 'sale', amountCents: 950 },
          { id: 'three', refId: 'saq_test', type: 'payout', amountCents: -500 },
          { id: 'four', refId: 'saq_test', type: 'payout_reversal', amountCents: 500 },
        ],
      });
    return Response.json({
      subaccountId: subaccount,
      active: true,
      balanceCents: 1800,
      availableCents: 1600,
      medBlockedCents: 200,
    });
  });
  const value = await wallet.read(id, { uid: 'merchant' });
  assert.equal(value.availableCents, 1600);
  assert.equal(value.transactions[0].breakdown!.gatewayFeeCents, 50);
  assert.equal(value.transactions[1].orderId, null);
  assert.equal(value.transactions[1].breakdown!.grossCents, null);
  assert.equal(value.transactions[2].amountCents, -500);
  assert.equal(value.transactions[3].amountCents, 500);
  assert.equal(value.totalReceivedCents, null);
  assert(!JSON.stringify(value).includes('PRIVATE_TEST_TOKEN'));
  await assert.rejects(() => wallet.read(id, { uid: 'other' }));
  mismatch = true;
  await assert.rejects(() => wallet.read(id, { uid: 'merchant' }), {
    code: 'WALLET_ACCOUNT_MISMATCH',
  });
});
