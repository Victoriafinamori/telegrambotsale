import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { BotStore } from '../server/bot-store.js';
import { SecretVault } from '../server/secret-vault.js';
import { PurinCashPayments } from '../server/purin-cash.js';
import { PlatformSubscriptions } from '../server/platform-subscriptions.js';
import { nextBillingMonth } from '../server/billing-period.js';
async function fixture() {
  const store = new MemoryDocuments(),
    key = randomBytes(32).toString('base64url'),
    generation = randomUUID(),
    accountId = randomUUID(),
    secret = 'SUBSCRIPTION_TEST_SECRET_ONLY',
    vault = new SecretVault(key);
  let now = new Date('2026-10-26T12:00:00Z'),
    posts = 0,
    failAfterCreate = false;
  const charges = new Map<string, any>();
  await store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + accountId, {
      id: accountId,
      firebase_uid: 'merchant',
      access_status: 'approved',
      billing_started_at: new Date('2026-10-01T12:00:00Z'),
      paid_through: new Date('2026-11-01T12:00:00Z'),
      price_cents: 999,
    });
    tx.set('merchant_bot_setup/' + accountId, {
      activation_status: 'active',
      telegram_user_id: '111111111',
      bot_id: '123456789',
    });
    tx.set('bot_shops/' + accountId, { owner_id: '111111111', owner_bot_id: '123456789' });
    tx.set('platform_payments/purincash', { generation });
    tx.set('platform_payments/purincash/connections/' + generation, {
      ciphertext: vault.seal(
        JSON.stringify({ token: 'ps_live_TEST_ONLY_123456789', secret }),
        'purin:' + generation,
      ),
    });
  });
  const request: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.origin, 'https://api.purincash.com');
    if (init?.method === 'POST') {
      posts++;
      const body = JSON.parse(String(init.body));
      assert(!body.subaccountId);
      const p = {
        ...body,
        paymentId: 'psc_' + randomUUID().replaceAll('-', ''),
        amountCents: body.valueCents,
        currency: 'BRL',
        environment: 'live',
        status: 'pending',
        pix: { brCode: '000201_TEST_SUBSCRIPTION_ONLY' },
      };
      charges.set(p.paymentId, p);
      if (failAfterCreate) throw Error('Unknown response after creation');
      return Response.json(p);
    }
    if (u.pathname === '/v1/charges') return Response.json({ charges: [...charges.values()] });
    const found = charges.get(u.pathname.split('/').at(-1)!);
    return found ? Response.json(found) : Response.json({ error: 'not found' }, { status: 404 });
  };
  const purin = new PurinCashPayments(
      store,
      key,
      new BotStore(store, key),
      'https://blackout.example.test',
      'https://api.example.test',
      request,
      () => now,
      true,
    ),
    service = new PlatformSubscriptions(
      store,
      key,
      purin,
      'https://blackout.example.test',
      'https://api.example.test',
      () => now,
    );
  await service.configure('admin', {
    revision: 0,
    prices: { monthly: 999, quarterly: 2450, annual: 8490 },
  });
  const notify = async (p: any, signatureValid = true) => {
    const raw = Buffer.from(
      JSON.stringify({ event: 'charge.paid', paymentId: p.paymentId, sandbox: false }),
    );
    await service.notify(
      generation,
      raw,
      signatureValid ? createHmac('sha256', secret).update(raw).digest('hex') : '0'.repeat(64),
      'charge.paid:' + p.paymentId,
    );
  };
  return {
    store,
    service,
    accountId,
    charges,
    notify,
    posts: () => posts,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    fail: () => (failAfterCreate = true),
  };
}
test('Subscription plans snapshot their price; one concurrent charge, no cross-merchant access, authoritative and idempotent renewal', async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.read(f.accountId, 'other'), { status: 403 });
  const [a, b] = await Promise.all([
    f.service.create(f.accountId, 'merchant', { plan: 'quarterly', requestId: randomUUID() }),
    f.service.create(f.accountId, 'merchant', { plan: 'quarterly', requestId: randomUUID() }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(f.posts(), 1);
  assert.equal(a.total, 2450);
  await f.service.configure('admin', {
    revision: 1,
    prices: { monthly: 1099, quarterly: 9999, annual: 8490 },
  });
  const p = [...f.charges.values()][0];
  await assert.rejects(() => f.notify(p, false), { status: 401 });
  await f.notify(p);
  assert.equal(
    (await f.store.get('merchant_accounts/' + f.accountId))!.paid_through.toISOString(),
    '2026-11-01T12:00:00.000Z',
  );
  p.status = 'paid';
  p.paidAt = '2026-10-26T12:00:00Z';
  p.amountCents = 2451;
  await assert.rejects(() => f.notify(p), { code: 'SUBSCRIPTION_MISMATCH' });
  p.amountCents = 2450;
  await Promise.all([
    f.notify(p),
    f.notify(p),
    f.service.check(f.accountId, 'merchant', { invoiceId: a.id }),
  ]);
  const account = (await f.store.get('merchant_accounts/' + f.accountId))!;
  assert.equal(account.paid_through.toISOString(), '2027-02-01T12:00:00.000Z');
  assert.equal(account.price_cents, 2450);
  assert.equal(account.billing_months, 3);
  assert.equal((await f.service.read(f.accountId, 'merchant')).invoice!.status, 'paid');
  assert.equal((await f.store.list('platform_subscription_payments', { limit: 100 })).length, 1);
  assert.equal(
    (await f.store.list('bot_shops/' + f.accountId + '/effects', { limit: 100 })).length,
    1,
  );
});
test('Unknown subscription creation reconciles without another POST and does not trust webhook amounts or ledger binding', async () => {
  const f = await fixture();
  f.fail();
  await assert.rejects(() =>
    f.service.create(f.accountId, 'merchant', { plan: 'annual', requestId: randomUUID() }),
  );
  const initial = (await f.service.read(f.accountId, 'merchant')).invoice!;
  assert.equal(initial.status, 'uncertain');
  await f.service.create(f.accountId, 'merchant', { plan: 'monthly', requestId: randomUUID() });
  assert.equal(f.posts(), 1);
  const p = [...f.charges.values()][0];
  p.status = 'paid';
  p.paidAt = '2026-10-26T12:00:00Z';
  p.subaccountId = 'sacc_OTHER';
  await assert.rejects(() => f.notify(p), { code: 'SUBSCRIPTION_MISMATCH' });
  delete p.subaccountId;
  await f.service.check(f.accountId, 'merchant', { invoiceId: initial.id });
  assert.equal(f.posts(), 1);
  assert.equal(
    (await f.store.get('merchant_accounts/' + f.accountId))!.paid_through.toISOString(),
    '2027-11-01T12:00:00.000Z',
  );
});
test('Expired access renews from payment confirmation; late payment or suspension requires review and cannot silently restore access', async () => {
  const f = await fixture();
  await f.store.transaction(async (tx) => {
    const a = (await tx.get('merchant_accounts/' + f.accountId))!;
    tx.set('merchant_accounts/' + f.accountId, {
      ...a,
      paid_through: new Date('2026-10-01T12:00:00Z'),
    });
  });
  await f.service.create(f.accountId, 'merchant', { plan: 'monthly', requestId: randomUUID() });
  const p = [...f.charges.values()][0];
  p.status = 'paid';
  p.paidAt = '2026-10-26T12:00:00Z';
  await f.notify(p);
  assert.equal(
    (await f.store.get('merchant_accounts/' + f.accountId))!.paid_through.toISOString(),
    '2026-11-26T12:00:00.000Z',
  );
  const later = await f.service.create(f.accountId, 'merchant', {
    plan: 'annual',
    requestId: randomUUID(),
  });
  const p2 = [...f.charges.values()][1];
  f.advance(7200000);
  p2.status = 'paid';
  p2.paidAt = '2026-10-26T14:00:00Z';
  await f.notify(p2);
  assert.equal((await f.service.read(f.accountId, 'merchant')).invoice!.status, 'review_required');
  assert.equal(
    (await f.store.get('merchant_accounts/' + f.accountId))!.paid_through.toISOString(),
    '2026-11-26T12:00:00.000Z',
  );
  assert(later.id);
});
test('Quarterly and annual periods clamp calendar month ends in Sao Paulo', () => {
  assert.equal(
    nextBillingMonth(new Date('2026-01-31T12:00:00Z'), 3).toISOString(),
    '2026-04-30T12:00:00.000Z',
  );
  assert.equal(
    nextBillingMonth(new Date('2024-02-29T12:00:00Z'), 12).toISOString(),
    '2025-02-28T12:00:00.000Z',
  );
});
