import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { BotStore } from '../server/bot-store.js';
import { SecretVault } from '../server/secret-vault.js';
import { PurinCashPayments } from '../server/purin-cash.js';
import { PlatformSubscriptions } from '../server/platform-subscriptions.js';
import { nextBillingMonth } from '../server/billing-period.js';
import { createApp } from '../server/app.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { testConfig } from './helpers.js';
async function fixture() {
  const store = new MemoryDocuments(),
    key = randomBytes(32).toString('base64url'),
    generation = randomUUID(),
    accountId = randomUUID(),
    secret = 'SUBSCRIPTION_TEST_SECRET_ONLY',
    vault = new SecretVault(key);
  let now = new Date('2026-10-26T12:00:00Z'),
    posts = 0,
    failAfterCreate = false,
    failRead = false,
    readOverride: Record<string, unknown> = {};
  const charges = new Map<string, any>();
  let ledgerRows: any[] = [];
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
      if (body.subaccountId) assert(Number.isSafeInteger(body.subaccountFeeCents));
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
      return Response.json({
        paymentId: p.paymentId,
        status: p.status,
        amountCents: p.amountCents,
        currency: p.currency,
        environment: p.environment,
        pix: p.pix,
      });
    }
    if (u.pathname.includes('/transactions'))
      return Response.json({ subaccountId: 'sacc_affiliate', transactions: ledgerRows });
    if (u.pathname === '/v1/subaccounts/sacc_affiliate')
      return Response.json({ subaccountId: 'sacc_affiliate', active: true });
    if (u.pathname === '/v1/charges') return Response.json({ charges: [...charges.values()] });
    const found = charges.get(u.pathname.split('/').at(-1)!);
    if (failRead) {
      failRead = false;
      throw Error('Read response interrupted');
    }
    if (!found) return Response.json({ error: 'not found' }, { status: 404 });
    const { environment, pix, ...detail } = found;
    return Response.json({ ...detail, ...readOverride });
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
    key,
    purin,
    accountId,
    generation,
    setLedger: (rows: any[]) => (ledgerRows = rows),
    charges,
    notify,
    posts: () => posts,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    fail: () => (failAfterCreate = true),
    failReadOnce: () => (failRead = true),
    overrideRead: (value: Record<string, unknown>) => (readOverride = value),
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

test('Initial checkout requires verified identity, freezes prices and creates exactly one paid merchant without starting the period', async () => {
  const f = await fixture(),
    buyer = { uid: 'new-buyer', email: 'new@example.test', emailVerified: true, authTime: 1 };
  const input = {
    name: 'Novo lojista',
    storeName: 'Nova loja',
    plan: 'quarterly',
    expectedPriceCents: 2450,
    requestId: randomUUID(),
  };
  await assert.rejects(() => f.service.purchaseCreate({ ...buyer, emailVerified: false }, input), {
    code: 'EMAIL_UNVERIFIED',
  });
  await assert.rejects(() => f.service.purchaseCreate(buyer, { ...input, expectedPriceCents: 1 }), {
    code: 'PLAN_PRICE_CHANGED',
  });
  assert.equal(f.posts(), 0);
  const [a, b] = await Promise.all([
    f.service.purchaseCreate(buyer, input),
    f.service.purchaseCreate(buyer, { ...input, requestId: randomUUID() }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.total, 2450);
  assert.equal(f.posts(), 1);
  assert.equal((await f.service.purchaseRead(buyer)).hasStore, false);
  assert.equal((await f.store.list('merchant_accounts', { limit: 100 })).length, 1);
  await assert.rejects(
    () => f.service.purchaseCheck({ ...buyer, uid: 'other' }, { invoiceId: a.id }),
    { status: 404 },
  );
  const p = [...f.charges.values()][0];
  await f.notify(p);
  assert.equal((await f.service.purchaseRead(buyer)).hasStore, false);
  p.status = 'paid';
  p.paidAt = '2026-10-26T12:00:00Z';
  await Promise.all([
    f.notify(p),
    f.notify(p),
    f.service.purchaseCheck(buyer, { invoiceId: a.id }),
  ]);
  const { tokenHash } = await import('../server/accounts.js');
  const link = (await f.store.get('platform_uids/' + tokenHash(buyer.uid)))!;
  const account = (await f.store.get('merchant_accounts/' + link.account_id))!;
  assert.equal(account.email, buyer.email);
  assert.equal(account.firebase_uid, buyer.uid);
  assert.equal(account.access_status, 'approved');
  assert.equal(account.billing_months, 3);
  assert.equal(account.price_cents, 2450);
  assert.equal(account.billing_started_at, null);
  assert.equal(account.paid_through, null);
  assert(account.purchase_confirmed_at instanceof Date);
  assert.equal(
    (await f.store.get('platform_emails/' + tokenHash(buyer.email)))!.account_id,
    account.id,
  );
  assert.equal((await f.store.list('merchant_accounts', { limit: 100 })).length, 2);
  assert.equal((await f.service.purchaseRead(buyer)).invoice!.status, 'paid');
  await assert.rejects(
    () => f.service.purchaseCreate(buyer, { ...input, requestId: randomUUID() }),
    { code: 'EXISTING_CONTRACT' },
  );
  assert.equal(f.posts(), 1);
});

test('Initial checkout lost creation response never repeats POST; late or conflicting paid purchase goes to review', async () => {
  const f = await fixture(),
    buyer = { uid: 'new-buyer', email: 'new@example.test', emailVerified: true, authTime: 1 };
  const input = {
    name: 'Novo lojista',
    storeName: 'Nova loja',
    plan: 'annual',
    expectedPriceCents: 8490,
    requestId: randomUUID(),
  };
  f.fail();
  await assert.rejects(() => f.service.purchaseCreate(buyer, input));
  const invoice = (await f.service.purchaseRead(buyer)).invoice!;
  assert.equal(invoice.status, 'uncertain');
  await f.service.purchaseCreate(buyer, { ...input, requestId: randomUUID() });
  assert.equal(f.posts(), 1);
  await f.service.purchaseCheck(buyer, { invoiceId: invoice.id });
  assert.equal((await f.service.purchaseRead(buyer)).invoice!.status, 'awaiting_payment');
  const p = [...f.charges.values()][0];
  p.status = 'paid';
  p.paidAt = '2026-10-26T14:00:00Z';
  f.advance(7200000);
  await f.notify(p);
  assert.equal((await f.service.purchaseRead(buyer)).invoice!.status, 'review_required');
  assert.equal((await f.service.purchaseRead(buyer)).hasStore, false);
  assert.equal(f.posts(), 1);
});

async function enableAffiliate(f: Awaited<ReturnType<typeof fixture>>) {
  const partner = randomUUID();
  await f.store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + partner, {
      id: partner,
      firebase_uid: 'affiliate',
      access_status: 'approved',
    });
    tx.set('merchant_bot_setup/' + partner, { telegram_user_id: '77', bot_id: '88' });
    tx.set('bot_shops/' + partner, {
      owner_id: '77',
      owner_bot_id: '88',
      purin_subaccount: 'sacc_affiliate',
      purin_connection: f.generation,
    });
    tx.set('purin_subaccount_claims/sacc_affiliate', { account_id: partner });
    tx.set('resale_profiles/' + partner, { plans: 'approved' });
    tx.set('resale_partners/' + partner, {
      id: partner,
      enabled: true,
      revision: 1,
      prices: { monthly: 1999, quarterly: 3450, annual: 9990 },
    });
  });
  return partner;
}
test('Affiliate initial purchase and renewal allocate only base in the charge and confirm margin through the recipient ledger once', async () => {
  const f = await fixture(),
    partner = await enableAffiliate(f),
    buyer = {
      uid: 'new-buyer',
      email: 'new@example.test',
      emailVerified: true,
      secondFactor: false,
      authTime: Date.now() / 1000,
    };
  const input = {
    plan: 'monthly',
    requestId: randomUUID(),
    expectedPriceCents: 1999,
    name: 'Buyer Test',
    storeName: 'Buyer Store',
    partnerId: partner,
  };
  const invoice = await f.service.purchaseCreate(buyer, input);
  const charge = [...f.charges.values()][0];
  assert.equal(charge.subaccountId, 'sacc_affiliate');
  assert.equal(charge.subaccountFeeCents, 999);
  charge.status = 'paid';
  charge.paidAt = '2026-10-26T12:00:00Z';
  await f.notify(charge);
  assert.equal(
    (await f.service.purchaseCheck(buyer, { invoiceId: invoice.id })).status,
    'awaiting_credit',
  );
  assert.equal((await f.store.list('resale_commissions', { limit: 10 })).length, 0);
  f.setLedger([
    { id: 'ledger1', refId: charge.paymentId, type: 'sale', amountCents: 930, feeCents: 999 },
  ]);
  await Promise.all([f.notify(charge), f.notify(charge)]);
  const result = await f.service.purchaseCheck(buyer, { invoiceId: invoice.id });
  assert.equal(result.status, 'paid');
  const commissions = await f.store.list('resale_commissions', { limit: 10 });
  assert.equal(commissions.length, 1);
  assert.equal(commissions[0].gatewayFeeCents, 70);
  assert.equal(commissions[0].partnerCents, 930);
  assert.equal(commissions[0].blackoutFeeCents, 0);
  const original = (await f.store.get('platform_subscription_invoices/' + invoice.id))!,
    account = (await f.store.get('merchant_accounts/' + original.account_id))!;
  assert.equal(account.price_cents, 999);
  assert.equal(account.resale_partner_id, partner);
  await f.store.transaction(async (tx) => {
    tx.set('merchant_accounts/' + account.id, {
      ...account,
      billing_started_at: new Date('2026-10-26T12:00:00Z'),
      paid_through: new Date('2026-11-26T12:00:00Z'),
    });
    tx.set('merchant_bot_setup/' + account.id, {
      activation_status: 'active',
      telegram_user_id: '99',
      bot_id: '100',
    });
  });
  const renewal = await f.service.create(account.id, buyer.uid, {
    plan: 'quarterly',
    requestId: randomUUID(),
    expectedPriceCents: 3450,
  });
  const second = [...f.charges.values()][1];
  assert.equal(second.subaccountFeeCents, 2450);
  assert.equal(second.subaccountId, 'sacc_affiliate');
  assert.equal(renewal.total, 3450);
  assert.equal(f.posts(), 2);
});
test('Affiliate revocation blocks new charges but cannot divert a previously created allocation', async () => {
  const f = await fixture(),
    partner = await enableAffiliate(f),
    buyer = {
      uid: 'buyer',
      email: 'buyer@example.test',
      emailVerified: true,
      secondFactor: false,
      authTime: 1,
    };
  const invoice = await f.service.purchaseCreate(buyer, {
    plan: 'monthly',
    requestId: randomUUID(),
    expectedPriceCents: 1999,
    name: 'Buyer Test',
    storeName: 'Buyer Store',
    partnerId: partner,
  });
  await f.store.transaction(async (tx) =>
    tx.set('resale_profiles/' + partner, { plans: 'revoked' }),
  );
  await assert.rejects(
    () =>
      f.service.purchaseCreate(
        { ...buyer, uid: 'other', email: 'other@example.test' },
        {
          plan: 'monthly',
          requestId: randomUUID(),
          expectedPriceCents: 1999,
          name: 'Other Test',
          storeName: 'Other Store',
          partnerId: partner,
        },
      ),
    { code: 'RESELLER_DISABLED' },
  );
  const charge = [...f.charges.values()][0];
  charge.status = 'paid';
  charge.paidAt = '2026-10-26T12:00:00Z';
  f.setLedger([{ refId: charge.paymentId, type: 'sale', amountCents: 930, feeCents: 999 }]);
  await f.notify(charge);
  assert.equal((await f.service.purchaseCheck(buyer, { invoiceId: invoice.id })).status, 'paid');
  assert.equal(f.posts(), 1);
});

test('Guest checkout takes payment before registration, stores no plaintext capability and binds once to a verified owner', async () => {
  const f = await fixture(),
    key = randomBytes(32).toString('hex');
  const input = { key, plan: 'monthly', requestId: randomUUID(), expectedPriceCents: 999 };
  const [a, b] = await Promise.all([
    f.service.guestCreate(input),
    f.service.guestCreate({ ...input, requestId: randomUUID() }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(f.posts(), 1);
  assert.equal((await f.store.list('merchant_accounts', { limit: 100 })).length, 1);
  const stored = (await f.store.get('platform_subscription_invoices/' + a.id))!;
  assert.equal(stored.email, '');
  assert.equal(stored.name, '');
  assert.equal(stored.store_name, '');
  assert(!JSON.stringify(stored).includes(key));
  assert(!JSON.stringify(a).includes('guest_key_hash'));
  await assert.rejects(() => f.service.guestRead({ invoiceId: a.id, key: '0'.repeat(64) }), {
    status: 404,
  });
  const buyer = { uid: 'guest-buyer', email: 'new@example.test', emailVerified: true, authTime: 1 };
  const claim = { invoiceId: a.id, key, name: 'Novo lojista', storeName: 'Nova loja' };
  await assert.rejects(() => f.service.guestClaim(buyer, claim), { code: 'PAYMENT_NOT_CONFIRMED' });
  const payment = [...f.charges.values()][0];
  payment.status = 'paid';
  payment.paidAt = '2026-10-26T12:00:00Z';
  await Promise.all([f.notify(payment), f.notify(payment)]);
  assert.equal((await f.service.guestRead({ key })).status, 'paid');
  assert.equal((await f.store.list('merchant_accounts', { limit: 100 })).length, 1);
  await assert.rejects(() => f.service.guestClaim({ ...buyer, emailVerified: false }, claim), {
    code: 'EMAIL_UNVERIFIED',
  });
  await assert.rejects(() => f.service.guestClaim(buyer, { ...claim, key: '1'.repeat(64) }), {
    status: 404,
  });
  const results = await Promise.all([
    f.service.guestClaim(buyer, claim),
    f.service.guestClaim(buyer, claim),
  ]);
  assert.equal(results[0].accountId, results[1].accountId);
  const account = (await f.store.get('merchant_accounts/' + results[0].accountId))!;
  assert.equal(account.email, buyer.email);
  assert.equal(account.name, 'Novo lojista');
  assert.equal(account.store_name, 'Nova loja');
  assert.equal(account.billing_started_at, null);
  assert.equal(account.paid_through, null);
  assert.equal((await f.service.guestRead({ key })).claimed, true);
  await assert.rejects(
    () => f.service.guestClaim({ ...buyer, uid: 'thief', email: 'thief@example.test' }, claim),
    { code: 'PAYMENT_ALREADY_USED' },
  );
  await f.notify(payment);
  assert.equal((await f.store.list('merchant_accounts', { limit: 100 })).length, 2);
});

test('Guest lost response and reload recover the same payment with the capability alone and never charge twice', async () => {
  const f = await fixture(),
    key = randomBytes(32).toString('hex'),
    input = { key, plan: 'annual', requestId: randomUUID(), expectedPriceCents: 8490 };
  f.fail();
  await assert.rejects(() => f.service.guestCreate(input));
  const invoice = await f.service.guestRead({ key });
  assert.equal(invoice.status, 'uncertain');
  await f.service.guestCreate({ ...input, requestId: randomUUID() });
  assert.equal(f.posts(), 1);
  const checked = await f.service.guestRead({ key }, true);
  assert.equal(checked.status, 'awaiting_payment');
  // GET /charges does not reproduce a QR that was lost with the POST response.
  assert.equal(checked.qrCode, '');
  const payment = [...f.charges.values()][0];
  payment.status = 'paid';
  payment.paidAt = '2026-10-26T14:00:00Z';
  f.advance(7200000);
  await f.notify(payment);
  assert.equal((await f.service.guestRead({ key })).status, 'review_required');
  await assert.rejects(
    () =>
      f.service.guestClaim(
        { uid: 'buyer', email: 'buyer@example.test', emailVerified: true, authTime: 1 },
        { invoiceId: invoice.id, key, name: 'Buyer', storeName: 'Store' },
      ),
    { code: 'PAYMENT_NOT_CONFIRMED' },
  );
});

test('Guest affiliate checkout preserves base and margin; registration cannot turn the payment into a self-referral', async () => {
  const f = await fixture(),
    partner = await enableAffiliate(f),
    key = randomBytes(32).toString('hex');
  const invoice = await f.service.guestCreate({
    key,
    plan: 'monthly',
    requestId: randomUUID(),
    expectedPriceCents: 1999,
    partnerId: partner,
  });
  const charge = [...f.charges.values()][0];
  assert.equal(charge.subaccountFeeCents, 999);
  charge.status = 'paid';
  charge.paidAt = '2026-10-26T12:00:00Z';
  await f.notify(charge);
  assert.equal((await f.service.guestRead({ key })).status, 'awaiting_credit');
  f.setLedger([
    { id: 'guest-ledger', refId: charge.paymentId, type: 'sale', amountCents: 930, feeCents: 999 },
  ]);
  await f.notify(charge);
  assert.equal((await f.service.guestRead({ key })).status, 'paid');
  const claim = { invoiceId: invoice.id, key, name: 'Buyer', storeName: 'Store' };
  await assert.rejects(
    () =>
      f.service.guestClaim(
        { uid: 'affiliate', email: 'affiliate@example.test', emailVerified: true, authTime: 1 },
        claim,
      ),
    { code: 'EXISTING_CONTRACT' },
  );
  const result = await f.service.guestClaim(
    { uid: 'new-buyer', email: 'buyer@example.test', emailVerified: true, authTime: 1 },
    claim,
  );
  const account = (await f.store.get('merchant_accounts/' + result.accountId))!;
  assert.equal(account.resale_partner_id, partner);
  assert.equal(account.price_cents, 999);
  const commissions = await f.store.list('resale_commissions', { limit: 10 });
  assert.equal(commissions.length, 1);
  assert.equal(commissions[0].partnerCents, 930);
  assert.equal(commissions[0].blackoutFeeCents, 0);
});

test('Guest HTTP checkout is public but rate limited; reading needs the secret and claiming still needs verified authentication', async () => {
  const f = await fixture(),
    platform = new FirestorePlatform(f.store, f.key),
    config = { ...testConfig(), API_AUTH_MODE: 'bearer' as const, BOT_TOKEN_ENCRYPTION_KEY: f.key };
  const app = createApp(
    config,
    platform,
    {
      verifyIdToken: async () => {
        throw Error('not authenticated');
      },
      verifySession: async () => {
        throw Error('not authenticated');
      },
      createSession: async () => '',
    },
    undefined,
    { onboarding: platform.onboarding, bots: new BotStore(f.store, f.key), purin: f.purin },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const post = (path: string, body: unknown) =>
    fetch('http://127.0.0.1:' + address.port + '/api/checkout/guest/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: config.APP_ORIGIN },
      body: JSON.stringify(body),
    });
  try {
    const key = randomBytes(32).toString('hex'),
      body = { key, plan: 'monthly', requestId: randomUUID(), expectedPriceCents: 999 };
    const response = await post('create', body);
    assert.equal(response.status, 200);
    const invoice = await response.json();
    assert(invoice.qrCode);
    assert.equal((await post('read', { invoiceId: invoice.id, key: '0'.repeat(64) })).status, 404);
    assert.equal((await post('read', { key })).status, 200);
    assert.equal(
      (await post('claim', { key, invoiceId: invoice.id, name: 'Buyer', storeName: 'Store' }))
        .status,
      401,
    );
    for (let i = 0; i < 4; i++) assert.equal((await post('create', body)).status, 200);
    assert.equal((await post('create', body)).status, 429);
    assert.equal(f.posts(), 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('Documented Purin creation omits metadata, detail omits environment and Pix, and the original QR survives an interrupted detail request', async () => {
  const f = await fixture(),
    key = randomBytes(32).toString('hex'),
    input = { key, plan: 'monthly', requestId: randomUUID(), expectedPriceCents: 999 };
  f.failReadOnce();
  await assert.rejects(() => f.service.guestCreate(input));
  const saved = await f.service.guestRead({ key });
  assert.equal(saved.status, 'creating');
  assert.equal(saved.qrCode, '');
  const data = (await f.store.get('platform_subscription_invoices/' + saved.id))!;
  assert(data.payment_id);
  assert(data.qr_ciphertext);
  assert(!JSON.stringify(data).includes('000201_TEST_SUBSCRIPTION_ONLY'));
  const recovered = await f.service.guestRead({ key }, true);
  assert.equal(recovered.status, 'awaiting_payment');
  assert.equal(recovered.qrCode, '000201_TEST_SUBSCRIPTION_ONLY');
  const again = await f.service.guestCreate({ ...input, requestId: randomUUID() });
  assert.equal(again.id, saved.id);
  assert.equal(f.posts(), 1);
});

for (const wrong of [
  { amountCents: 1 },
  { currency: 'USD' },
  { environment: 'sandbox' },
  { sandbox: true },
  { metadata: '{}' },
  { customer: { externalId: 'another-purchase' } },
  { subaccountId: 'sacc_other' },
])
  test(
    'Subscription detail continues rejecting mismatched financial or ownership fields: ' +
      Object.keys(wrong).join(','),
    async () => {
      const f = await fixture(),
        key = randomBytes(32).toString('hex');
      f.overrideRead(wrong);
      await assert.rejects(
        () =>
          f.service.guestCreate({
            key,
            plan: 'monthly',
            requestId: randomUUID(),
            expectedPriceCents: 999,
          }),
        { code: 'SUBSCRIPTION_MISMATCH' },
      );
      const invoice = await f.service.guestRead({ key });
      assert.equal(invoice.status, 'creating');
      assert.equal(invoice.qrCode, '');
      assert.equal((await f.store.list('merchant_accounts', { limit: 100 })).length, 1);
      assert.equal(f.posts(), 1);
    },
  );
