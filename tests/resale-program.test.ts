import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocuments } from './document-memory.js';
import { ResaleProgram } from '../server/resale-program.js';
import { ResaleCatalog } from '../server/resale-catalog.js';
import type { MerchantConsole } from '../server/merchant-console.js';
const supplier = '11111111-1111-4111-8111-111111111111',
  partner = '22222222-2222-4222-8222-222222222222',
  other = '33333333-3333-4333-8333-333333333333',
  pid = 'abcdef123456';
async function fixture() {
  const store = new MemoryDocuments();
  const reads: any[] = [];
  await store.transaction(async (tx) => {
    for (const [id, uid] of [
      [supplier, 'owner'],
      [partner, 'partner'],
      [other, 'other-admin'],
    ])
      tx.set('merchant_accounts/' + id, {
        id,
        firebase_uid: uid,
        access_status: 'approved',
        store_name: uid,
        name: uid,
      });
    tx.set('platform_billing/settings', {
      revision: 0,
      prices: { monthly: 999, quarterly: 2450, annual: 8490 },
    });
    tx.set('bot_shops/' + supplier, {
      products: [{ id: pid, title: 'Produto global', enabled: true, price: 999, stock: 1 }],
    });
    tx.set(`bot_shops/${supplier}/products/${pid}`, {
      units: [{ ciphertext: 'PRIVATE-CODE', id: 'private' }],
    });
  });
  const console = {
    read: async (id: string, uid: string) => {
      reads.push([id, uid]);
      return { products: (await store.get('bot_shops/' + id))!.products };
    },
    inventory: async (id: string, uid: string, product: string) => {
      reads.push([id, uid, product]);
      return { units: [] };
    },
  } as unknown as MerchantConsole;
  const service = new ResaleProgram(
    store,
    async (uid) => ['owner', 'other-admin'].includes(uid),
    console,
  );
  return { store, service, reads, catalog: new ResaleCatalog(store) };
}
test('Primary owner binds her existing inventory once; merchant and another administrator cannot take it over', async () => {
  const { service, store, reads } = await fixture();
  await assert.rejects(() => service.initialize('partner', partner), {
    code: 'PLATFORM_OWNER_REQUIRED',
  });
  await assert.rejects(() => service.initialize('owner', partner), {
    code: 'RESELLER_OWNER_REQUIRED',
  });
  await service.initialize('owner', supplier);
  await service.initialize('owner', supplier);
  assert.equal((await service.global('owner')).configured, true);
  await assert.rejects(() => service.initialize('other-admin', other), {
    code: 'PLATFORM_OWNER_REQUIRED',
  });
  await assert.rejects(() => service.global('other-admin'), { code: 'PLATFORM_OWNER_REQUIRED' });
  assert.deepEqual(reads, [[supplier, 'owner']]);
  assert.equal((await store.get(`bot_shops/${supplier}/products/${pid}`))!.units.length, 1);
});
test('Ordinary merchants start with no resale permissions and opt in independently; approval requires their request', async () => {
  const { service } = await fixture();
  await service.initialize('owner', supplier);
  const ordinary = await service.own(partner, 'partner');
  assert.equal(ordinary.kind, 'merchant');
  assert.deepEqual(ordinary.permissions, { products: 'none', plans: 'none' });
  await assert.rejects(
    () =>
      service.decide('owner', partner, { capability: 'products', status: 'approved', revision: 0 }),
    { code: 'OPT_IN_REQUIRED' },
  );
  await service.request(partner, 'partner', { capability: 'products', enabled: true, revision: 0 });
  assert.equal((await service.own(partner, 'partner')).kind, 'merchant');
  await service.decide('owner', partner, {
    capability: 'products',
    status: 'approved',
    revision: 1,
  });
  const approved = await service.own(partner, 'partner');
  assert.equal(approved.kind, 'reseller');
  assert.equal(approved.permissions.plans, 'none');
  await assert.rejects(
    () => service.request(partner, 'owner', { capability: 'plans', enabled: true, revision: 2 }),
    { code: 'RESELLER_OWNER_REQUIRED' },
  );
  await assert.rejects(
    () => service.request(partner, 'partner', { capability: 'plans', enabled: true, revision: 1 }),
    { code: 'RESALE_CHANGED' },
  );
});
test('Approval exposes the global catalog by default; supplier prices and explicit blocks remain authoritative', async () => {
  const { service, store, catalog } = await fixture();
  await service.initialize('owner', supplier);
  assert.equal((await service.offers(partner, 'partner')).products.length, 0);
  await service.request(partner, 'partner', { capability: 'products', enabled: true, revision: 0 });
  await service.decide('owner', partner, {
    capability: 'products',
    status: 'approved',
    revision: 1,
  });
  const offers = await service.offers(partner, 'partner');
  assert.equal(offers.products.length, 1);
  assert.equal(offers.products[0].baseCents, 999);
  await assert.rejects(() => catalog.quoteProduct(supplier, partner, 'partner', pid, 999), {
    code: 'RESELLER_PRICE_TOO_LOW',
  });
  await service.grant('owner', {
    partnerId: partner,
    productId: pid,
    baseCents: 899,
    enabled: true,
    revision: 0,
  });
  assert.equal((await service.offers(partner, 'partner')).products[0].baseCents, 899);
  await service.grant('owner', {
    partnerId: partner,
    productId: pid,
    baseCents: 899,
    enabled: false,
    revision: 1,
  });
  assert.equal((await service.offers(partner, 'partner')).products.length, 0);
  await assert.rejects(() => catalog.quoteProduct(supplier, partner, 'partner', pid, 1600), {
    code: 'SUPPLIER_UNAVAILABLE',
  });
});

test('Supplier grants expose only approved products, with immediate revocation and separate plans permission', async () => {
  const { service, catalog } = await fixture();
  await service.initialize('owner', supplier);
  const grant = { partnerId: partner, productId: pid, baseCents: 500, enabled: true, revision: 0 };
  await assert.rejects(() => service.grant('owner', grant), { code: 'RESELLER_DISABLED' });
  await service.request(partner, 'partner', { capability: 'products', enabled: true, revision: 0 });
  await service.decide('owner', partner, {
    capability: 'products',
    status: 'approved',
    revision: 1,
  });
  await service.grant('owner', grant);
  const offers = await service.offers(partner, 'partner');
  assert.equal(offers.products.length, 1);
  assert(!JSON.stringify(offers).includes('PRIVATE-CODE'));
  await assert.rejects(
    () =>
      catalog.saveAffiliate(partner, 'partner', {
        revision: 0,
        enabled: true,
        prices: { monthly: 1999, quarterly: 3450, annual: 9990 },
      }),
    { code: 'RESELLER_NOT_APPROVED' },
  );
  await service.request(partner, 'partner', { capability: 'plans', enabled: true, revision: 2 });
  await service.decide('owner', partner, { capability: 'plans', status: 'approved', revision: 3 });
  await catalog.saveAffiliate(partner, 'partner', {
    revision: 0,
    enabled: true,
    prices: { monthly: 1999, quarterly: 3450, annual: 9990 },
  });
  await service.request(partner, 'partner', {
    capability: 'products',
    enabled: false,
    revision: 4,
  });
  assert.equal((await service.offers(partner, 'partner')).products.length, 0);
  assert.equal((await catalog.quotePlan(partner, 'buyer', 'monthly')).total, 1999);
  await service.decide('owner', partner, { capability: 'plans', status: 'revoked', revision: 5 });
  await assert.rejects(() => catalog.quotePlan(partner, 'buyer', 'monthly'), {
    code: 'RESELLER_DISABLED',
  });
});
