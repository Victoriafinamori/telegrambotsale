import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocuments } from './document-memory.js';
import { ResaleCatalog, resaleBreakdown } from '../server/resale-catalog.js';
const supplier = '11111111-1111-4111-8111-111111111111',
  partner = '22222222-2222-4222-8222-222222222222',
  pid = 'abcdef123456';
async function fixture() {
  const store = new MemoryDocuments();
  await store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + supplier, {
      firebase_uid: 'supplier',
      access_status: 'approved',
    });
    tx.set('merchant_accounts/' + partner, { firebase_uid: 'partner', access_status: 'approved' });
    tx.set('resale_profiles/' + partner, {
      id: partner,
      plans: 'approved',
      products: 'approved',
      revision: 1,
    });
    tx.set('platform_billing/settings', {
      revision: 1,
      prices: { monthly: 999, quarterly: 2450, annual: 8490 },
    });
    tx.set('bot_shops/' + supplier, {
      products: [
        { id: pid, title: 'Licença', description: 'Produto digital', enabled: true, stock: 1 },
      ],
    });
    tx.set(`bot_shops/${supplier}/products/${pid}`, {
      units: [{ id: 'private', ciphertext: 'NEVER-EXPOSE' }],
    });
  });
  return { store, service: new ResaleCatalog(store) };
}
test('Affiliate quotes use server base and partner price, reject impersonation and self-referral, and become invalid when base rises', async () => {
  const { service, store } = await fixture();
  const input = {
    revision: 0,
    enabled: true,
    prices: { monthly: 1999, quarterly: 3450, annual: 9990 },
  };
  await assert.rejects(() => service.saveAffiliate(partner, 'supplier', input), {
    code: 'RESELLER_OWNER_REQUIRED',
  });
  await service.saveAffiliate(partner, 'partner', input);
  const quote = await service.quotePlan(partner, 'buyer', 'monthly');
  assert.equal(quote.total, 1999);
  assert.equal(quote.baseCents, 999);
  assert.equal(quote.blackoutFeeCents, 0);
  await assert.rejects(() => service.quotePlan(partner, 'partner', 'monthly'), {
    code: 'SELF_REFERRAL',
  });
  await assert.rejects(() => service.saveAffiliate(partner, 'partner', input), {
    code: 'OFFER_CHANGED',
  });
  await store.transaction(async (tx) =>
    tx.set('platform_billing/settings', {
      revision: 2,
      prices: { monthly: 2500, quarterly: 2450, annual: 8490 },
    }),
  );
  await assert.rejects(() => service.quotePlan(partner, 'buyer', 'monthly'), {
    code: 'RESELLER_PRICE_TOO_LOW',
  });
  assert.equal((await service.affiliateSettings(partner, 'partner')).checkoutReady, false);
});
test('Supplier authorizes a specific product and partner, exposes no delivery, and revocation takes effect on the next quote', async () => {
  const { service, store } = await fixture();
  const grant = { partnerId: partner, productId: pid, baseCents: 2000, enabled: true, revision: 0 };
  await assert.rejects(() => service.grantProduct(supplier, 'partner', grant), {
    code: 'RESELLER_OWNER_REQUIRED',
  });
  await service.grantProduct(supplier, 'supplier', grant);
  const quote = await service.quoteProduct(supplier, partner, 'partner', pid, 3500);
  assert.equal(quote.baseCents, 2000);
  assert.equal(quote.stock, 1);
  assert(!JSON.stringify(quote).includes('NEVER-EXPOSE'));
  assert(!JSON.stringify(quote).includes('units'));
  await assert.rejects(() => service.quoteProduct(supplier, partner, 'supplier', pid, 3500), {
    code: 'RESELLER_OWNER_REQUIRED',
  });
  await service.grantProduct(supplier, 'supplier', { ...grant, revision: 1, enabled: false });
  await assert.rejects(() => service.quoteProduct(supplier, partner, 'partner', pid, 3500), {
    code: 'SUPPLIER_UNAVAILABLE',
  });
  assert.equal((await store.get(`bot_shops/${supplier}/products/${pid}`))!.units.length, 1);
});
test('Plan margin protects base, charges no 12%, and withholds any fee shortfall instead of inventing withdrawable money', () => {
  assert.deepEqual(
    resaleBreakdown({ kind: 'plan', grossCents: 1999, baseCents: 999, gatewayFeeCents: 70 }),
    {
      kind: 'plan',
      grossCents: 1999,
      baseCents: 999,
      gatewayFeeCents: 70,
      blackoutFeeCents: 0,
      partnerCents: 930,
      shortfallCents: 0,
      status: 'reconciled',
    },
  );
  const loss = resaleBreakdown({
    kind: 'plan',
    grossCents: 1000,
    baseCents: 999,
    gatewayFeeCents: 70,
  });
  assert.equal(loss.partnerCents, 0);
  assert.equal(loss.shortfallCents, 69);
  assert.equal(loss.status, 'review_required');
  assert.throws(
    () =>
      resaleBreakdown({
        kind: 'plan',
        grossCents: 1999,
        baseCents: 999,
        gatewayFeeCents: 70,
        blackoutFeeCents: 100,
      }),
    { code: 'PLAN_MARKUP_FORBIDDEN' },
  );
});
