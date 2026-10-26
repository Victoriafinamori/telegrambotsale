import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MemoryDocuments } from './document-memory.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { BotStore } from '../server/bot-store.js';
import { MerchantConsole } from '../server/merchant-console.js';
import type { BotEffect, TelegramUpdate, Order, Shop } from '../server/bot-types.js';
import { createApp } from '../server/app.js';
import { testConfig } from './helpers.js';
import {
  BotRuntimeApi,
  processTelegramUpdate,
  dispatchEffects,
  RuntimeApiError,
} from '../server/bot-runner.js';
import { TelegramClient, TelegramError } from '../server/telegram-client.js';
import { botTransaction } from '../server/bot-data.js';
import { MercadoPagoPayments, validMpSignature } from '../server/mercado-pago.js';
import { pixKey, manualPixText } from '../server/pix.js';
import { PurinCashPayments, validPurinSignature } from '../server/purin-cash.js';
import { PaymentGateway } from '../server/payment-gateway.js';
import { tokenHash } from '../server/accounts.js';
import { PurinWallet } from '../server/purin-wallet.js';
import { SecretVault } from '../server/secret-vault.js';
import { randomUUID } from 'node:crypto';

async function walletFixture() {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual');
  let now = new Date('2026-10-25T12:00:00Z'),
    balance = 5000,
    mode = 'completed';
  const generation = randomUUID(),
    subaccount = 'sacc_wallet',
    vault = new SecretVault(f.key),
    token = 'ps_live_' + 'W'.repeat(40),
    payments = new Map<string, any>(),
    posts: any[] = [];
  await botTransaction(f.store, async (tx) => {
    const shop = (await tx.get('bot_shops/' + f.a.id))!;
    tx.set('bot_shops/' + f.a.id, {
      ...shop,
      purin_connection: generation,
      purin_subaccount: subaccount,
    });
    tx.set('platform_payments/purincash', { generation, withdrawals_enabled: true });
    tx.set('platform_payments/purincash/connections/' + generation, {
      ciphertext: vault.seal(
        JSON.stringify({ token, secret: 'TEST_SECRET_ONLY' }),
        'purin:' + generation,
      ),
    });
  });
  const transport: typeof fetch = async (url, init) => {
    const address = new URL(String(url));
    assert.equal(address.origin, 'https://api.purincash.com');
    assert(address.pathname.startsWith('/v1/subaccounts/' + subaccount));
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (mode === 'reject')
        return Response.json({ error: 'permission required' }, { status: 403 });
      if (!payments.has(body.idempotencyKey)) {
        balance -= body.amountCents;
        payments.set(body.idempotencyKey, {
          subaccountId: subaccount,
          amountCents: body.amountCents,
          status: mode === 'timeout' ? 'processing' : 'completed',
          reversed: false,
          feeCents: 0,
          platformFeeCents: 100,
          netAmountCents: body.amountCents - 100,
          code: 'TURBO-TEST',
        });
      }
      if (mode === 'timeout') throw Error('Simulated network timeout after bank submission');
      return Response.json({ success: true });
    }
    if (address.pathname.includes('/payouts/')) {
      const key = address.pathname.split('/').at(-1)!.slice(9),
        payment = payments.get(key);
      return payment
        ? Response.json(payment)
        : Response.json({ error: 'not found' }, { status: 404 });
    }
    if (address.pathname.endsWith('/transactions'))
      return Response.json({
        transactions: [
          {
            id: 'sale-test',
            type: 'sale',
            amountCents: 5000,
            description: 'Venda teste',
            createdAt: now.toISOString(),
          },
        ],
      });
    return Response.json({
      subaccountId: subaccount,
      active: true,
      balanceCents: balance,
      medBlockedCents: 1000,
      availableCents: Math.max(0, balance - 1000),
      totalReceivedCents: 5000,
      payoutFeePercent: 0,
      payoutFeeFixedCents: 0,
    });
  };
  const wallet = new PurinWallet(
    f.store,
    f.key,
    'https://store.example.test',
    transport,
    () => now,
  );
  f.bots.wallet = wallet;
  const actor = { telegram: '111111111', auth: f.auth };
  const prepare = (amountCents = 1000) =>
    wallet.prepare(
      f.a.id,
      { uid: 'merchant' },
      { requestId: randomUUID(), amountCents, pixType: 'email', pixKey: 'merchant@example.test' },
    );
  return {
    f,
    wallet,
    actor,
    prepare,
    posts,
    payments,
    token,
    setMode(value: string) {
      mode = value;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      f.advance(ms);
    },
  };
}

test('Wallet exposes only the merchant subaccount available balance, rejects other identities and overdraws', async () => {
  const p = await walletFixture();
  const data = await p.wallet.read(p.f.a.id, { uid: 'merchant' });
  assert.equal(data.availableCents, 4000);
  assert.equal(data.blockedCents, 1000);
  await assert.rejects(() => p.wallet.read(p.f.a.id, { uid: 'other' }), {
    code: 'WALLET_OWNER_REQUIRED',
  });
  await assert.rejects(() => p.wallet.read(p.f.a.id, { telegram: '222222222', auth: p.f.auth }), {
    code: 'WALLET_OWNER_REQUIRED',
  });
  await assert.rejects(() => p.prepare(4001), { code: 'WALLET_BALANCE' });
  assert.equal(p.posts.length, 0);
  assert(!JSON.stringify(data).includes(p.token));
});

test('Withdrawal requires matching web authorization and Telegram owner, sends once under concurrent/replayed confirmations', async () => {
  const p = await walletFixture(),
    draft = await p.prepare();
  await assert.rejects(() => p.wallet.execute(p.f.a.id, p.actor, draft.id), {
    code: 'WITHDRAWAL_WEB_CONFIRM_REQUIRED',
  });
  await assert.rejects(() => p.wallet.requestApproval(p.f.a.id, 'other', { draftId: draft.id }), {
    code: 'WALLET_OWNER_REQUIRED',
  });
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: draft.id });
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: draft.id });
  assert.equal(
    (await p.f.store.list(`bot_shops/${p.f.a.id}/effects`, { limit: 1000 })).filter((e) =>
      e.id.startsWith('wallet_approval_'),
    ).length,
    1,
  );
  await Promise.all([
    p.wallet.execute(p.f.a.id, p.actor, draft.id),
    p.wallet.execute(p.f.a.id, p.actor, draft.id),
  ]);
  const result = await p.wallet.execute(p.f.a.id, p.actor, draft.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.netAmountCents, 900);
  assert.equal(result.feeCents, 100);
  assert.equal(p.posts.length, 1);
  assert(p.posts[0].idempotencyKey.startsWith('blackout_'));
  assert.equal(p.posts[0].pixKey, 'merchant@example.test');
  const row = await p.f.store.get(`merchant_wallets/${p.f.a.id}/withdrawals/${draft.id}`);
  assert(!JSON.stringify(row).includes('merchant@example.test'));
});

test('Uncertain withdrawal never repeats POST or releases its lock until authoritative reconciliation', async () => {
  const p = await walletFixture();
  p.setMode('timeout');
  const draft = await p.prepare();
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: draft.id });
  assert.equal((await p.wallet.execute(p.f.a.id, p.actor, draft.id)).status, 'processing');
  await p.wallet.execute(p.f.a.id, p.actor, draft.id);
  assert.equal(p.posts.length, 1);
  const second = await p.prepare(500);
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: second.id });
  await assert.rejects(() => p.wallet.execute(p.f.a.id, p.actor, second.id), {
    code: 'WITHDRAWAL_BUSY',
  });
  const payment = [...p.payments.values()][0];
  payment.status = 'completed';
  assert.equal((await p.wallet.sync(p.f.a.id, { uid: 'merchant' }, draft.id)).status, 'completed');
  assert.equal((await p.f.store.get('platform_payments/purincash'))!.active_withdrawal, null);
  assert.equal(p.posts.length, 1);
});

test('Cancelled, expired or revoked withdrawal approvals cannot transfer funds; definite provider refusal releases the lock', async () => {
  const p = await walletFixture(),
    cancelled = await p.prepare();
  await p.wallet.cancel(p.f.a.id, { uid: 'merchant' }, cancelled.id);
  assert.equal((await p.wallet.execute(p.f.a.id, p.actor, cancelled.id)).status, 'cancelled');
  assert.equal(p.posts.length, 0);
  const expired = await p.prepare();
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: expired.id });
  p.advance(300001);
  await assert.rejects(() => p.wallet.execute(p.f.a.id, p.actor, expired.id));
  assert.equal(p.posts.length, 0);
  const next = await p.prepare();
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: next.id });
  p.setMode('reject');
  assert.equal((await p.wallet.execute(p.f.a.id, p.actor, next.id)).status, 'failed');
  assert.equal(p.posts.length, 1);
  assert.equal((await p.f.store.get('platform_payments/purincash'))!.active_withdrawal, null);
  const revoked = await p.prepare();
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId: revoked.id });
  await p.f.store.transaction(async (tx) => {
    const runtime = (await tx.get('bot_runtimes/' + p.f.a.id))!;
    tx.set('bot_runtimes/' + p.f.a.id, { ...runtime, generation: randomUUID() });
  });
  await assert.rejects(() => p.wallet.execute(p.f.a.id, p.actor, revoked.id), {
    code: 'WALLET_OWNER_REQUIRED',
  });
  assert.equal(p.posts.length, 1);
});

test('Wallet HTTP derives merchant identity, blocks arbitrary account IDs and has no browser execution endpoint', async () => {
  const p = await walletFixture(),
    f = p.f,
    cfg = {
      ...testConfig(),
      PLATFORM_DATABASE: 'firestore' as const,
      API_AUTH_MODE: 'bearer' as const,
      BOT_TOKEN_ENCRYPTION_KEY: f.key,
    };
  const auth = {
    verifyIdToken: async (token: string) => ({ ...f.identity, uid: token }),
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(cfg, f.p, auth, undefined, {
    onboarding: f.p.onboarding,
    bots: f.bots,
    wallet: p.wallet,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    headers = {
      Origin: cfg.APP_ORIGIN,
      'Content-Type': 'application/json',
      Authorization: 'Bearer merchant',
    };
  try {
    assert.equal((await fetch(origin + '/api/store/manage/wallet')).status, 401);
    assert.equal(
      (
        await fetch(origin + '/api/store/manage/wallet', {
          headers: { ...headers, Authorization: 'Bearer other' },
        })
      ).status,
      403,
    );
    const own = await fetch(origin + '/api/store/manage/wallet', { headers });
    assert.equal(own.status, 200);
    const data = await own.json();
    assert.equal(data.availableCents, 4000);
    assert(!JSON.stringify(data).includes(p.token));
    assert.equal(
      (
        await fetch(origin + '/api/store/manage/wallet/prepare', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            accountId: 'other',
            requestId: randomUUID(),
            amountCents: 1000,
            pixType: 'email',
            pixKey: 'merchant@example.test',
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(origin + '/api/store/manage/wallet/execute', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(origin + '/api/admin/payments/purin/withdrawals', {
          method: 'POST',
          headers,
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
      403,
    );
    assert.equal(p.posts.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('Subscription HTTP derives the account from identity and protects plan prices from merchant changes', async () => {
  const f = await fixture(),
    cfg = {
      ...testConfig(),
      PLATFORM_DATABASE: 'firestore' as const,
      API_AUTH_MODE: 'bearer' as const,
      BOT_TOKEN_ENCRYPTION_KEY: f.key,
    };
  const auth = {
    verifyIdToken: async (token: string) => ({ ...f.identity, uid: token }),
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(cfg, f.p, auth, undefined, {
    onboarding: f.p.onboarding,
    bots: f.bots,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    headers = {
      Origin: cfg.APP_ORIGIN,
      'Content-Type': 'application/json',
      Authorization: 'Bearer merchant',
    };
  try {
    assert.equal((await fetch(origin + '/api/store/subscription')).status, 401);
    const publicPlans = await fetch(origin + '/api/checkout/plans');
    assert.equal(publicPlans.status, 200);
    assert.equal((await publicPlans.json()).plans.length, 3);
    assert.equal((await fetch(origin + '/api/checkout/purchase')).status, 401);
    assert.equal(
      (
        await fetch(origin + '/api/checkout/purchase/create', {
          method: 'POST',
          headers: { Origin: cfg.APP_ORIGIN, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal((await fetch(origin + '/api/checkout/purchase', { headers })).status, 200);
    assert.equal(
      (
        await fetch(origin + '/api/checkout/purchase/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: 'Test',
            storeName: 'Test store',
            plan: 'monthly',
            expectedPriceCents: 999,
            requestId: randomUUID(),
            uid: 'someone-else',
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(origin + '/api/store/subscription', {
          headers: { ...headers, Authorization: 'Bearer other' },
        })
      ).status,
      403,
    );
    const own = await fetch(origin + '/api/store/subscription', { headers });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).plans.length, 3);
    assert.equal((await fetch(origin + '/api/admin/subscription-plans', { headers })).status, 403);
    assert.equal(
      (
        await fetch(origin + '/api/admin/subscription-plans', {
          method: 'POST',
          headers,
          body: JSON.stringify({ revision: 0, prices: { monthly: 1, quarterly: 1, annual: 1 } }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/store/subscription/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            plan: 'monthly',
            requestId: randomUUID(),
            accountId: randomUUID(),
            priceCents: 1,
          }),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('Subscription reminders cover 10, 5, 3, 2, 1 days once, include renewal links and skip obsolete notices', async () => {
  const f = await fixture(),
    due = new Date('2026-11-04T12:00:00Z');
  await f.store.transaction(async (tx) => {
    const a = (await tx.get('merchant_accounts/' + f.a.id))!;
    tx.set('merchant_accounts/' + f.a.id, { ...a, paid_through: due });
  });
  for (const step of [0, 5, 2, 1, 1]) {
    f.advance(step * 86400000);
    await f.bots.tick(f.auth);
    await f.bots.tick(f.auth);
  }
  const reminders = (await f.store.list('bot_shops/' + f.a.id + '/effects', { limit: 100 })).filter(
    (e) => e.subscription_reminder_due,
  );
  assert.equal(reminders.length, 5);
  const screens = await f.effects(reminders.map((e) => e.id));
  for (const day of [10, 5, 3, 2, 1])
    assert(screens.some((e) => String(e.payload.text).includes(`em ${day} dia(s)`)));
  for (const e of screens)
    assert((e.payload.reply_markup as any).inline_keyboard[0][0].url.includes('?subscription=1'));
  f.advance(86400000);
  await f.bots.tick(f.auth);
  const expired = (await f.store.list('bot_shops/' + f.a.id + '/effects', { limit: 100 })).find(
    (e) => e.subscription_reminder_due && e.status === 'pending',
  )!;
  await f.bots.renew(f.a.id, 'admin', randomUUID());
  assert.equal(await f.bots.claim(f.auth, expired.id), null);
});

test('Store start shows management only to the verified merchant and offers Blackout to buyers', async () => {
  const f = await fixture();
  const keyboard = (effects: BotEffect[]) =>
    (
      effects.find((e) => e.payload.reply_markup)?.payload.reply_markup as any
    ).inline_keyboard.flat();
  const buyer = keyboard(await f.send(222222222, '/start'));
  assert(
    !buyer.some((b: any) => b.callback_data === 'admin' || b.callback_data === 'admin:wallet'),
  );
  assert(!buyer.some((b: any) => /Receber avisos|Gerenciar loja|Carteira/.test(b.text)));
  assert(
    buyer.some(
      (b: any) =>
        b.text.includes('Quero um bot igual') && b.url === 'https://blackout-create.web.app/',
    ),
  );
  const owner = keyboard(await f.send(111111111, '/start'));
  assert(owner.some((b: any) => b.callback_data === 'admin'));
  assert(owner.some((b: any) => b.callback_data === 'admin:wallet'));
  const denied = await f.click(222222222, 'admin');
  assert(denied.some((e) => String(e.payload.text).includes('somente ao responsável')));
  await f.store.transaction(async (tx) => {
    const setup = (await tx.get('merchant_bot_setup/' + f.a.id))!;
    tx.set('merchant_bot_setup/' + f.a.id, { ...setup, telegram_user_id: '333333333' });
  });
  const formerOwner = keyboard(await f.send(111111111, '/start'));
  assert(
    !formerOwner.some(
      (b: any) => b.callback_data === 'admin' || b.callback_data === 'admin:wallet',
    ),
  );
});

test('Telegram wallet wizard uses owner binding, web review and explicit confirmation; buyer gets no wallet', async () => {
  const p = await walletFixture();
  const denied = await p.f.click(222222222, 'admin:wallet');
  assert(denied.some((e) => String(e.payload.text).includes('exclusiva')));
  const view = await p.f.send(111111111, '/carteira');
  assert(view.some((e) => String(e.payload.text).includes('Disponível para saque')));
  await p.f.click(111111111, 'wallet:new');
  await p.f.send(111111111, '10,00');
  await p.f.click(111111111, 'wallet:type:email');
  const preview = await p.f.send(111111111, 'merchant@example.test');
  const screen = preview.find((e) => String(e.payload.text).includes('Confirmar saque'))!;
  assert(screen);
  const buttons = (screen.payload.reply_markup as any).inline_keyboard.flat();
  assert(buttons.some((b: any) => b.url?.includes('/#/minha-loja?wallet=')));
  const confirm = buttons.find((b: any) =>
      b.callback_data?.startsWith('wallet:confirm:'),
    ).callback_data,
    draftId = confirm.slice(15);
  await p.f.click(111111111, confirm);
  assert.equal(p.posts.length, 0);
  await p.wallet.requestApproval(p.f.a.id, 'merchant', { draftId });
  await p.f.click(111111111, confirm);
  assert.equal(p.posts.length, 1);
});

test('Buyer navigation edits existing text/media screens instead of adding a message per click', async () => {
  const f = await fixture(),
    pid = await f.product();
  const press = async (data: string, photo = false) => {
    const update = f.callback(222222222, data);
    update.callback_query!.message = {
      chat: { id: 222222222, type: 'private' },
      message_id: 50,
      ...(photo ? { photo: [{ file_id: 'product_photo' }] } : {}),
    };
    return f.effects((await f.bots.process(f.auth, update)).effectIds);
  };
  for (let i = 0; i < 2; i++) {
    const result = await press('catalog');
    assert(result.some((e) => e.method === 'editMessageText' && e.payload.message_id === 50));
    assert(!result.some((e) => e.method === 'sendMessage'));
  }
  await f.store.transaction(async (tx) => {
    const shop = (await tx.get('bot_shops/' + f.a.id))!;
    shop.products[0].banner = 'photo_test';
    tx.set('bot_shops/' + f.a.id, shop);
  });
  const photo = await press('p:' + pid);
  assert(photo.some((e) => e.method === 'editMessageMedia' && (e.payload.media as any).caption));
  const back = await press('catalog', true);
  assert.equal(back.filter((e) => e.method === 'deleteMessage').length, 1);
  assert.equal(back.filter((e) => e.method === 'sendMessage').length, 1);
  const client = new TelegramClient('123456789:' + 'A'.repeat(35), async () =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description:
          'Bad Request: message is not modified: specified new message content is exactly the same',
      },
      { status: 400 },
    ),
  );
  assert.equal(await client.call('editMessageText', {}), true);
  await assert.rejects(() => client.call('sendMessage', {}), { code: 400 });
});

test('Add to cart returns to the category; buy now checks out only the chosen item and preserves the existing cart', async () => {
  const f = await fixture(),
    first = await f.product(),
    second = await f.product();
  const details = await f.click(222222222, 'p:' + first),
    buttons = (
      details.find((e) => e.method === 'sendMessage')!.payload.reply_markup as any
    ).inline_keyboard.flat();
  assert(buttons.some((b: any) => b.callback_data === 'buy:' + first));
  assert(buttons.some((b: any) => b.callback_data === 'add:' + first));
  const added = await f.click(222222222, 'add:' + first);
  assert(added.some((e) => String(e.payload.text).includes('Escolha um produto')));
  const cartBefore = await f.store.get(`bot_shops/${f.a.id}/customers/222222222`);
  const direct = await f.click(222222222, 'buy:' + second),
    invoice = direct.find((e) => e.method === 'sendInvoice')!;
  assert(invoice);
  const order = await f.store.get(`bot_shops/${f.a.id}/orders/${invoice.payload.payload}`);
  assert.equal(order!.items.length, 1);
  assert.equal(order!.items[0].product_id, second);
  assert.equal(order!.items[0].quantity, 1);
  assert.deepEqual(
    (await f.store.get(`bot_shops/${f.a.id}/customers/222222222`))!.items,
    cartBefore!.items,
  );
});

test('Stock alerts require opt-in, survive restart, notify once after web restock, and honour cancellation before send', async () => {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual'),
    pid = await f.product([]);
  const details = await f.click(222222222, 'p:' + pid),
    keyboard = (
      details.find((e) => e.method === 'sendMessage')!.payload.reply_markup as any
    ).inline_keyboard.flat();
  assert(keyboard.some((b: any) => b.callback_data === 'watch:' + pid));
  assert(!keyboard.some((b: any) => b.callback_data.startsWith('buy:')));
  const prompt = await f.click(222222222, 'watch:' + pid);
  assert(prompt.some((e) => String(e.payload.text).includes('Quer receber um aviso')));
  await f.click(222222222, 'watch-on:' + pid);
  await f.click(222222222, 'watch-on:' + pid);
  await f.click(333333333, 'watch-off:' + pid);
  await f.bots.tick(f.auth);
  assert.equal(
    (await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 1000 })).filter(
      (e) => e.stock_watch_id,
    ).length,
    0,
  );
  const portal = new MerchantConsole(f.store, f.key, f.bots);
  await portal.addStock(f.a.id, 'merchant', {
    productId: pid,
    units: ['NEW_LICENSE'],
    requestId: crypto.randomUUID(),
  });
  const restarted = new BotStore(f.store, f.key, () => new Date('2026-10-25T12:00:00Z'));
  await restarted.tick(f.auth);
  await restarted.tick(f.auth);
  const alerts = (await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 1000 })).filter(
    (e) => e.stock_watch_id,
  );
  assert.equal(alerts.length, 1);
  const delivered = await f.effects(alerts.map((e) => e.id));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.chat_id, '222222222');
  assert.equal((await f.effects(alerts.map((e) => e.id))).length, 0);
  // Cancel a second subscription after it has been queued, before dispatch.
  await f.store.transaction(async (tx) => {
    const shop = (await tx.get('bot_shops/' + f.a.id))!;
    shop.products[0].stock = 0;
    tx.set('bot_shops/' + f.a.id, shop);
  });
  await f.click(444444444, 'watch-on:' + pid);
  await f.store.transaction(async (tx) => {
    const shop = (await tx.get('bot_shops/' + f.a.id))!;
    shop.products[0].stock = 1;
    tx.set('bot_shops/' + f.a.id, shop);
  });
  await restarted.tick(f.auth);
  await f.click(444444444, 'watch-off:' + pid);
  const second = (await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 1000 })).filter((e) =>
    e.stock_watch_id?.endsWith('_444444444'),
  );
  assert.equal((await f.effects(second.map((e) => e.id))).length, 0);
});

test('Category emojis are merchant-chosen, optional, editable without renaming and preserved across rename', async () => {
  const f = await fixture(),
    portal = new MerchantConsole(f.store, f.key, f.bots);
  await f.product();
  let data = await portal.read(f.a.id, 'merchant');
  await portal.manageCategory(f.a.id, 'merchant', {
    action: 'rename',
    name: 'Arquivos',
    newName: 'Arquivos',
    emoji: '🔥',
    revision: data.revision,
  });
  const catalog = await f.click(222222222, 'catalog'),
    labels = JSON.stringify(catalog.map((e) => e.payload.reply_markup));
  assert(labels.includes('🔥 Arquivos'));
  assert(!labels.includes('📁'));
  data = await portal.read(f.a.id, 'merchant');
  await portal.manageCategory(f.a.id, 'merchant', {
    action: 'rename',
    name: 'Arquivos',
    newName: 'Downloads',
    revision: data.revision,
  });
  assert.equal((await portal.read(f.a.id, 'merchant')).category_emojis.Downloads, '🔥');
  await f.click(111111111, 'admin:category:' + tokenHash('Downloads').slice(0, 16));
  await f.send(111111111, 'remover');
  assert.equal((await portal.read(f.a.id, 'merchant')).category_emojis.Downloads, '');
  data = await portal.read(f.a.id, 'merchant');
  await assert.rejects(() =>
    portal.createCategory(f.a.id, 'merchant', {
      name: 'Inválida',
      emoji: 'dois emojis 🔥🛒',
      revision: data.revision,
    }),
  );
});

async function purinFixture(failCreate = false) {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual');
  let now = new Date('2026-10-25T12:00:00Z'),
    posts = 0;
  let rejectNext = false,
    failPreflight = false;
  const charges = new Map<string, any>(),
    secret = 'WEBHOOK_SYNTHETIC_' + 'a'.repeat(32),
    token = 'ps_live_' + 'b'.repeat(40);
  const transport: typeof fetch = async (url, init) => {
    const address = new URL(String(url));
    assert.equal(address.origin, 'https://api.purincash.com');
    if (address.pathname === '/v1/subaccounts') return Response.json({ subaccounts: [] });
    if (address.pathname.startsWith('/v1/subaccounts/')) {
      if (failPreflight) {
        failPreflight = false;
        throw Error('Simulated read failure');
      }
      return Response.json({
        subaccountId: address.pathname.split('/').at(-1),
        active: true,
        externalId: f.a.id,
      });
    }
    if (init?.method === 'POST') {
      posts++;
      if (rejectNext) {
        rejectNext = false;
        return Response.json(
          { error: 'Antes de receber pagamentos, acesse Carteira → Verificar Chave PIX.' },
          { status: 403 },
        );
      }
      const body = JSON.parse(String(init.body)),
        id = 'psc_test' + posts;
      const payment = {
        paymentId: id,
        amountCents: body.valueCents,
        currency: 'BRL',
        environment: 'live',
        status: 'pending',
        metadata: body.metadata,
        customer: body.customer,
        subaccountId: body.subaccountId,
        pix: { brCode: 'PIX_SIMULADO_NAO_PAGAR' },
      };
      assert.equal(body.subaccountFeeCents, 0);
      charges.set(id, payment);
      if (failCreate) throw Error('Simulated lost response');
      return Response.json(payment);
    }
    if (address.pathname === '/v1/charges')
      return Response.json({ charges: [...charges.values()] });
    const payment = charges.get(address.pathname.split('/').at(-1)!);
    assert(payment);
    return Response.json(payment);
  };
  const service = new PurinCashPayments(
    f.store,
    f.key,
    f.bots,
    'https://store.example.test',
    'https://api.example.test',
    transport,
    () => now,
  );
  f.bots.checkoutOrigin = 'https://store.example.test';
  await service.connect('admin', { accessToken: token, webhookSecret: secret });
  await service.bind(f.a.id, 'admin', { subaccountId: 'sacc_pilot' });
  const mp = new MercadoPagoPayments(
    f.store,
    f.key,
    f.bots,
    'https://store.example.test',
    'https://api.example.test',
    transport,
  );
  const settings = await mp.settings(f.a.id, 'merchant');
  await mp.saveSettings(f.a.id, 'merchant', {
    mode: 'purincash',
    revision: settings.revision,
    keys: [],
    instructions: '',
  });
  const pid = await f.product();
  await f.click(222222222, 'add:' + pid);
  const effects = await f.click(222222222, 'checkout');
  const effect = effects.find((e) => String(e.payload.text).includes('Pix automático'))!;
  const url = (effect.payload.reply_markup as any).inline_keyboard[0][0].url;
  const [, , accountId, orderId, key] = new URL(url).hash.split('/');
  const base = { accountId, orderId, key };
  const generation = (await f.store.get('bot_shops/' + f.a.id))!.purin_connection;
  const notify = async (payment: any) => {
    const raw = Buffer.from(JSON.stringify({ event: 'charge.paid', paymentId: payment.paymentId }));
    return service.notify(
      generation,
      raw,
      createHmac('sha256', secret).update(raw).digest('hex'),
      'charge.paid:' + payment.paymentId,
    );
  };
  return {
    f,
    service,
    mp,
    base,
    pid,
    charges,
    generation,
    secret,
    token,
    notify,
    posts: () => posts,
    rejectNext: () => {
      rejectNext = true;
    },
    failPreflight: () => {
      failPreflight = true;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      f.advance(ms);
    },
  };
}

test('Purin receiver verification rejection remains actionable and permits retry only after a definite rejection', async () => {
  const p = await purinFixture();
  p.rejectNext();
  await assert.rejects(() => p.service.create(p.base), {
    code: 'PURIN_RECEIVER_UNVERIFIED',
    providerStatus: 403,
  });
  const before = await p.service.details(p.base);
  assert.equal(before.chargeState, 'rejected');
  assert(before.paymentError.includes('Verificar Chave PIX'));
  assert.equal(p.charges.size, 0);
  const refresh = await p.service.refresh(p.base);
  assert.equal(refresh.chargeState, 'rejected');
  assert.equal(p.posts(), 1);
  const created = await p.service.create(p.base);
  assert(created.qrCode);
  assert.equal(p.charges.size, 1);
  assert.equal(p.posts(), 2);
  await p.service.create(p.base);
  assert.equal(p.posts(), 2);
});

test('Purin preflight failure does not consume the creation attempt, and concurrent clicks send one POST', async () => {
  const p = await purinFixture();
  p.failPreflight();
  await assert.rejects(() => p.service.create(p.base), { code: 'PURIN_UNAVAILABLE' });
  assert.equal((await p.service.details(p.base)).chargeState, 'not_created');
  assert.equal(p.posts(), 0);
  await Promise.all([p.service.create(p.base), p.service.create(p.base)]);
  assert.equal(p.posts(), 1);
  assert.equal(p.charges.size, 1);
});

test('Purin checkout binds server amount and subaccount, queues delivery once, and protects secrets and capabilities', async () => {
  const p = await purinFixture(),
    gateway = new PaymentGateway(p.mp, p.service);
  await assert.rejects(() => gateway.details({ ...p.base, key: 'x'.repeat(43) }), {
    code: 'CHECKOUT_NOT_FOUND',
  });
  const first = await gateway.create(p.base);
  assert(first.qrCode);
  assert.equal(first.qrBase64, ''); // Remote image URLs are never fetched; browser renders BR Code locally.
  await gateway.create(p.base);
  assert.equal(p.posts(), 1);
  const payment = [...p.charges.values()][0];
  payment.status = 'paid';
  await p.notify(payment);
  await p.notify(payment);
  const order = await p.f.store.get(`bot_shops/${p.f.a.id}/orders/${p.base.orderId}`);
  assert.equal(order!.status, 'paid');
  assert.equal(order!.delivery_effects.length, 1);
  const delivered = await p.f.effects(order!.delivery_effects);
  assert.equal(delivered.length, 1);
  assert.equal((await p.f.effects(order!.delivery_effects)).length, 0);
  const audit =
    JSON.stringify(await p.service.platformStatus()) +
    JSON.stringify(await p.mp.settings(p.f.a.id, 'merchant'));
  assert(!audit.includes(p.token));
  assert(!audit.includes(p.secret));
  const privateRows = JSON.stringify(
    await p.f.store.list('platform_payments/purincash/connections', { limit: 20 }),
  );
  assert(!privateRows.includes(p.token));
  assert(!privateRows.includes(p.secret));
});

test('Purin rejects forged raw-body signatures, wrong amount/subaccount/environment and sandbox notifications', async () => {
  const p = await purinFixture();
  await p.service.create(p.base);
  const payment = [...p.charges.values()][0];
  payment.status = 'paid';
  const body = Buffer.from('{"event":"charge.paid","paymentId":"psc_test1"}');
  assert(
    validPurinSignature(body, createHmac('sha256', p.secret).update(body).digest('hex'), p.secret),
  );
  assert(
    !validPurinSignature(
      Buffer.from(body.toString() + ' '),
      createHmac('sha256', p.secret).update(body).digest('hex'),
      p.secret,
    ),
  );
  await assert.rejects(
    () => p.service.notify(p.generation, body, 'a'.repeat(64), 'charge.paid:psc_test1'),
    { code: 'PURIN_SIGNATURE_INVALID' },
  );
  for (const [field, wrong] of [
    ['amountCents', 99999],
    ['subaccountId', 'sacc_other'],
    ['environment', 'sandbox'],
  ] as const) {
    const old = payment[field];
    payment[field] = wrong;
    await assert.rejects(() => p.notify(payment), { code: 'PURIN_PAYMENT_MISMATCH' });
    payment[field] = old;
  }
  const order = await p.f.store.get(`bot_shops/${p.f.a.id}/orders/${p.base.orderId}`);
  assert.equal(order!.status, 'awaiting_payment');
});

test('Purin lost create response never repeats POST, and paid expired orders do not deliver or duplicate returned stock', async () => {
  const p = await purinFixture(true);
  await assert.rejects(() => p.service.create(p.base), { code: 'PURIN_UNAVAILABLE' });
  await p.service.create(p.base);
  assert.equal(p.posts(), 1);
  const payment = [...p.charges.values()][0];
  payment.status = 'paid';
  p.advance(3600001);
  await p.notify(payment);
  await p.notify(payment);
  const order = await p.f.store.get(`bot_shops/${p.f.a.id}/orders/${p.base.orderId}`);
  assert.equal(order!.status, 'refund_required');
  assert(!order!.delivery_effects?.length);
  assert.equal((await p.f.store.get(`bot_shops/${p.f.a.id}/products/${p.pid}`))!.units.length, 2);
});

test('Purin master credentials and subaccount binding cannot be changed by merchants over HTTP', async () => {
  const p = await purinFixture(),
    f = p.f,
    cfg = {
      ...testConfig(),
      PLATFORM_DATABASE: 'firestore' as const,
      API_AUTH_MODE: 'bearer' as const,
      BOT_TOKEN_ENCRYPTION_KEY: f.key,
    };
  const auth = {
    verifyIdToken: async () => f.identity,
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(cfg, f.p, auth, undefined, {
    onboarding: f.p.onboarding,
    bots: f.bots,
    payments: p.mp,
    purin: p.service,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    for (const path of [
      '/api/admin/payments/purin/connect',
      `/api/admin/accounts/${f.a.id}/purin`,
    ]) {
      assert.equal(
        (
          await fetch(origin + path, {
            method: 'POST',
            headers: {
              Origin: cfg.APP_ORIGIN,
              'Content-Type': 'application/json',
              Authorization: 'Bearer merchant',
            },
            body: '{}',
          })
        ).status,
        403,
      );
    }
    const response = await fetch(origin + '/payments/purincash/' + p.generation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function pixFixture(failFirst = false) {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual');
  let time = new Date('2026-10-25T12:00:00Z'),
    fail = failFirst,
    sent = 0;
  const token = 'APP_USR_' + 'PRIVATE_TEST_VALUE'.repeat(3),
    secret = 'WEBHOOK_PRIVATE_' + 'a'.repeat(32);
  const payments = new Map<string, Record<string, any>>(),
    posts: { key: string; body: any }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const address = String(url);
    if (address.startsWith('https://api.telegram.org/')) {
      sent++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent } }));
    }
    assert(address.startsWith('https://api.mercadopago.com/'));
    if (address.endsWith('/users/me'))
      return new Response(
        JSON.stringify({ id: 998877, site_id: 'MLB', nickname: 'Loja teste simulado', tags: [] }),
      );
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)),
        key = new Headers(init.headers).get('X-Idempotency-Key')!;
      posts.push({ key, body });
      let payment = [...payments.values()].find(
        (p) => p.external_reference === body.external_reference,
      );
      if (!payment) {
        payment = {
          id: String(1000 + payments.size),
          live_mode: true,
          external_reference: body.external_reference,
          collector_id: 998877,
          currency_id: 'BRL',
          payment_method_id: 'pix',
          transaction_amount: body.transaction_amount,
          status: 'pending',
          point_of_interaction: {
            transaction_data: { qr_code: 'PIX_SIMULADO_NAO_PAGAR', qr_code_base64: 'iVBORw0KGgo=' },
          },
        };
        payments.set(String(payment.id), payment);
      }
      if (fail) {
        fail = false;
        throw Error('Simulated network loss');
      }
      return new Response(JSON.stringify(payment));
    }
    const payment = payments.get(address.split('/').at(-1)!);
    assert(payment);
    return new Response(JSON.stringify(payment));
  };
  const service = new MercadoPagoPayments(
    f.store,
    f.key,
    f.bots,
    'https://store.example.test',
    'https://api.example.test',
    transport,
    () => time,
  );
  let settings = await service.settings(f.a.id, 'merchant');
  await service.connect(f.a.id, 'merchant', {
    accessToken: token,
    webhookSecret: secret,
    revision: settings.revision,
  });
  settings = await service.settings(f.a.id, 'merchant');
  await service.saveSettings(f.a.id, 'merchant', {
    mode: 'mercadopago',
    keys: [],
    instructions: '',
    revision: settings.revision,
  });
  const pid = await f.product();
  await f.click(222222222, 'add:' + pid);
  const effects = await f.click(222222222, 'checkout');
  const row = effects.find((e) => String(e.payload.text).includes('Pix automático'))!;
  const url = (row.payload.reply_markup as any).inline_keyboard[0][0].url as string;
  const [, , accountId, orderId, key] = new URL(url).hash.split('/');
  const base = { accountId, orderId, key },
    payer = { email: 'payer@example.test', documentType: 'CPF', document: '52998224725' };
  const generation = (await f.store.get('bot_shops/' + f.a.id))!.mp_connection as string;
  const signature = (
    id: string,
    signatureSecret = secret,
    timestamp = String(Math.floor(time.getTime() / 1000)),
  ) =>
    'ts=' +
    timestamp +
    ',v1=' +
    createHmac('sha256', signatureSecret)
      .update(`id:${id};request-id:request-1;ts:${timestamp};`)
      .digest('hex');
  return {
    f,
    service,
    token,
    secret,
    base,
    payer,
    pid,
    payments,
    posts,
    generation,
    signature,
    sent: () => sent,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
      f.advance(ms);
    },
  };
}

test('Payment HTTP protects owner settings and capability checkout, while signed webhooks work without browser origin', async () => {
  const p = await pixFixture(),
    f = p.f;
  const cfg = {
    ...testConfig(),
    PLATFORM_DATABASE: 'firestore' as const,
    API_AUTH_MODE: 'bearer' as const,
    BOT_TOKEN_ENCRYPTION_KEY: f.key,
  };
  const auth = {
    verifyIdToken: async (token: string) => {
      if (token !== 'merchant') throw Error();
      return f.identity;
    },
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(cfg, f.p, auth, undefined, {
    onboarding: f.p.onboarding,
    bots: f.bots,
    payments: p.service,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const headers = { Origin: cfg.APP_ORIGIN, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(origin + '/api/store/manage/payments')).status, 401);
    const options = await fetch(origin + '/api/store/manage/payments', {
      headers: { ...headers, Authorization: 'Bearer merchant' },
    });
    assert.equal(options.status, 200);
    const json = JSON.stringify(await options.json());
    assert(!json.includes(p.token));
    assert(!json.includes(p.secret));
    assert.equal(
      (
        await fetch(origin + '/api/payments/checkout/details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p.base),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/payments/checkout/details', {
          method: 'POST',
          headers,
          body: JSON.stringify(p.base),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/api/payments/checkout/details', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...p.base, key: 'a'.repeat(43) }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(origin + '/api/payments/checkout/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...p.base, payer: p.payer, total: 1 }),
        })
      ).status,
      400,
    );
    const created = await fetch(origin + '/api/payments/checkout/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...p.base, payer: p.payer }),
    });
    assert.equal(created.status, 200);
    const payment = [...p.payments.values()][0];
    payment.status = 'approved';
    const url = `${origin}/payments/mercadopago/${f.a.id}/${p.generation}?data.id=${payment.id}`;
    const body = JSON.stringify({ type: 'payment', data: { id: payment.id } });
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }))
        .status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-signature': p.signature(payment.id),
            'x-request-id': 'request-1',
          },
          body,
        })
      ).status,
      200,
    );
    assert.equal((await p.service.details(p.base)).status, 'delivered');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('Pending Pix keeps its original credential generation after the merchant updates the connection', async () => {
  const p = await pixFixture();
  await p.service.create({ ...p.base, payer: p.payer });
  const settings = await p.service.settings(p.f.a.id, 'merchant');
  await p.service.connect(p.f.a.id, 'merchant', {
    accessToken: 'APP_USR_' + 'NEW_PRIVATE_VALUE'.repeat(3),
    webhookSecret: 'NEW_SECRET_' + 'b'.repeat(32),
    revision: settings.revision,
  });
  const payment = [...p.payments.values()][0];
  payment.status = 'approved';
  await p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1');
  assert.equal((await p.service.details(p.base)).status, 'delivered');
});

test('Structured Pix keys validate CPF/CNPJ, email, phone and random key types', () => {
  for (const key of [
    { type: 'cpf', value: '529.982.247-25' },
    { type: 'cnpj', value: '11.222.333/0001-81' },
    { type: 'email', value: 'loja@example.test' },
    { type: 'phone', value: '+55 (11) 99999-9999' },
    { type: 'random', value: '12345678-1234-4234-8234-123456789012' },
  ])
    assert(pixKey.safeParse({ ...key, holder: 'Loja' }).success, key.type);
  assert(!pixKey.safeParse({ type: 'cpf', value: '11111111111', holder: '' }).success);
  assert(!pixKey.safeParse({ type: 'email', value: 'not-email', holder: '' }).success);
  assert(
    manualPixText({
      pix_keys: [{ type: 'email', value: 'loja@example.test', holder: 'Minha loja' }],
      payment_instructions: 'Envie comprovante',
    } as any).includes('E-mail: loja@example.test'),
  );
});

test('Automatic Pix uses a private capability and idempotency; provider credentials and payer data stay encrypted', async () => {
  const p = await pixFixture(true);
  const disabled = new MercadoPagoPayments(
    p.f.store,
    p.f.key,
    p.f.bots,
    'https://store.example.test',
    'https://api.example.test',
    async () => {
      throw Error('Network must not be used');
    },
    undefined,
    false,
  );
  await assert.rejects(
    async () =>
      disabled.connect(p.f.a.id, 'merchant', {
        accessToken: p.token,
        webhookSecret: p.secret,
        revision: (await p.service.settings(p.f.a.id, 'merchant')).revision,
      }),
    { code: 'PAYMENT_DEMO_ONLY' },
  );
  await assert.rejects(() => p.service.create({ ...p.base, payer: p.payer }), {
    code: 'MP_UNAVAILABLE',
  });
  const result = await p.service.create({
    ...p.base,
    payer: { ...p.payer, email: 'different@example.test' },
  });
  assert.equal(result.qrCode, 'PIX_SIMULADO_NAO_PAGAR');
  assert.equal(p.payments.size, 1);
  assert.equal(p.posts.length, 2);
  assert.equal(p.posts[0].key, p.posts[1].key);
  assert.deepEqual(p.posts[0].body, p.posts[1].body);
  assert(
    new Date(p.posts[0].body.date_of_expiration).getTime() - Date.parse('2026-10-25T12:00:00Z') >=
      1800000,
  );
  const settings = JSON.stringify(await p.service.settings(p.f.a.id, 'merchant'));
  assert(!settings.includes(p.token));
  assert(!settings.includes(p.secret));
  const stored = JSON.stringify(
    await p.f.store.get(`merchant_payment_secrets/${p.base.accountId}/payments/${p.base.orderId}`),
  );
  assert(!stored.includes(p.payer.email));
  assert(!stored.includes(p.payer.document));
  await assert.rejects(() => p.service.details({ ...p.base, key: 'a'.repeat(43) }), {
    code: 'CHECKOUT_NOT_FOUND',
  });
  await assert.rejects(() => p.service.settings(p.f.a.id, 'other'), { code: 'STORE_NOT_APPROVED' });
  const connection = JSON.stringify(
    await p.f.store.get(`merchant_payment_secrets/${p.f.a.id}/connections/${p.generation}`),
  );
  assert(!connection.includes(p.token));
  assert(!connection.includes(p.secret));
});

test('Signed Mercado Pago confirmation verifies amount and collector and delivers exactly once', async () => {
  const p = await pixFixture();
  await p.service.create({ ...p.base, payer: p.payer });
  const payment = [...p.payments.values()][0];
  payment.status = 'approved';
  await assert.rejects(
    () =>
      p.service.notify(
        p.f.a.id,
        p.generation,
        payment.id,
        p.signature(payment.id, 'bad-secret'),
        'request-1',
      ),
    { code: 'MP_SIGNATURE_INVALID' },
  );
  payment.transaction_amount++;
  await assert.rejects(
    () =>
      p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1'),
    { code: 'MP_PAYMENT_MISMATCH' },
  );
  payment.transaction_amount--;
  payment.collector_id = 1;
  await assert.rejects(
    () =>
      p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1'),
    { code: 'MP_PAYMENT_MISMATCH' },
  );
  payment.collector_id = 998877;
  payment.currency_id = 'USD';
  await assert.rejects(
    () =>
      p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1'),
    { code: 'MP_PAYMENT_MISMATCH' },
  );
  payment.currency_id = 'BRL';
  payment.live_mode = false;
  await assert.rejects(
    () =>
      p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1'),
    { code: 'MP_PAYMENT_MISMATCH' },
  );
  payment.live_mode = true;
  await p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1');
  const order = await p.f.store.get(`bot_shops/${p.f.a.id}/orders/${p.base.orderId}`);
  assert.equal(order!.status, 'delivered');
  const sent = p.sent();
  await p.service.notify(p.f.a.id, p.generation, payment.id, p.signature(payment.id), 'request-1');
  assert.equal(p.sent(), sent);
  assert.equal((await p.f.store.get('bot_shops/' + p.f.a.id))!.stats.paid_orders, 1);
  assert(
    !validMpSignature(
      p.signature(payment.id, p.secret, '1000000000'),
      'request-1',
      payment.id,
      p.secret,
      new Date('2026-10-25T12:00:00Z'),
    ),
  );
});

test('Late or cancelled automatic Pix goes to review without delivery or duplicate stock; reversals do not deliver', async () => {
  for (const state of [
    'late',
    'cancelled',
    'refunded',
    'provider-cancelled',
    'partial-refund',
  ] as const) {
    const p = await pixFixture();
    await p.service.create({ ...p.base, payer: p.payer });
    const payment = [...p.payments.values()][0];
    if (state === 'partial-refund') payment.transaction_amount_refunded = 0.5;
    if (state === 'late') p.advance(61 * 60000);
    if (state === 'cancelled') await p.f.click(222222222, 'cancel:' + p.base.orderId);
    payment.status =
      state === 'refunded' ? 'refunded' : state === 'provider-cancelled' ? 'cancelled' : 'approved';
    await p.service.notify(
      p.f.a.id,
      p.generation,
      payment.id,
      p.signature(payment.id),
      'request-1',
    );
    const order = await p.f.store.get(`bot_shops/${p.f.a.id}/orders/${p.base.orderId}`);
    assert.equal(
      order!.status,
      state === 'refunded'
        ? 'refunded'
        : state === 'provider-cancelled'
          ? 'cancelled'
          : 'refund_required',
    );
    assert(!order!.delivery_effects?.length);
    const stockKey = `bot_shops/${p.f.a.id}/products/${p.pid}`;
    assert.equal((await p.f.store.get(stockKey))!.units.length, 2);
    await p.service.notify(
      p.f.a.id,
      p.generation,
      payment.id,
      p.signature(payment.id),
      'request-1',
    );
    assert.equal((await p.f.store.get(stockKey))!.units.length, 2);
  }
});

test('Category rename and deletion move products atomically while preserving stock and existing orders', async () => {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual');
  const pid = await f.product(),
    portal = new MerchantConsole(f.store, f.key, f.bots);
  const oid = await manualCheckout(f, 222222222, pid);
  const stockKey = `bot_shops/${f.a.id}/products/${pid}`,
    orderKey = `bot_shops/${f.a.id}/orders/${oid}`;
  const stock = await f.store.get(stockKey),
    order = await f.store.get(orderKey);
  let snapshot = await portal.read(f.a.id, 'merchant');
  await assert.rejects(
    () =>
      portal.manageCategory(f.a.id, 'other', {
        action: 'rename',
        name: 'Arquivos',
        newName: 'Licenças',
        revision: snapshot.revision,
      }),
    { code: 'STORE_NOT_APPROVED' },
  );
  const oldRevision = snapshot.revision;
  await portal.manageCategory(f.a.id, 'merchant', {
    action: 'rename',
    name: 'Arquivos',
    newName: 'Licenças',
    revision: oldRevision,
  });
  await assert.rejects(
    () =>
      portal.manageCategory(f.a.id, 'merchant', {
        action: 'delete',
        name: 'Licenças',
        revision: oldRevision,
      }),
    { code: 'STORE_CHANGED' },
  );
  snapshot = await portal.read(f.a.id, 'merchant');
  assert.equal(snapshot.products[0].category, 'Licenças');
  assert(!snapshot.categories.includes('Arquivos'));
  await assert.rejects(
    () =>
      portal.manageCategory(f.a.id, 'merchant', {
        action: 'delete',
        name: 'Licenças',
        revision: snapshot.revision,
      }),
    { code: 'CATEGORY_HAS_PRODUCTS' },
  );
  await portal.createCategory(f.a.id, 'merchant', { name: 'Destino', revision: snapshot.revision });
  snapshot = await portal.read(f.a.id, 'merchant');
  await assert.rejects(
    () =>
      portal.manageCategory(f.a.id, 'merchant', {
        action: 'rename',
        name: 'Licenças',
        newName: 'Destino',
        revision: snapshot.revision,
      }),
    { code: 'CATEGORY_EXISTS' },
  );
  await portal.manageCategory(f.a.id, 'merchant', {
    action: 'delete',
    name: 'Licenças',
    destination: 'Destino',
    revision: snapshot.revision,
  });
  snapshot = await portal.read(f.a.id, 'merchant');
  assert.equal(snapshot.products[0].category, 'Destino');
  assert(!snapshot.categories.includes('Licenças'));
  assert.deepEqual(await f.store.get(stockKey), stock);
  assert.deepEqual(await f.store.get(orderKey), order);
  await portal.createCategory(f.a.id, 'merchant', { name: 'Vazia', revision: snapshot.revision });
  snapshot = await portal.read(f.a.id, 'merchant');
  await portal.manageCategory(f.a.id, 'merchant', {
    action: 'delete',
    name: 'Vazia',
    revision: snapshot.revision,
  });
  assert(!(await portal.read(f.a.id, 'merchant')).categories.includes('Vazia'));
});

test('Product moves persist within their category and Telegram renders the saved order after restart', async () => {
  const f = await fixture(),
    portal = new MerchantConsole(f.store, f.key, f.bots);
  const first = await f.product(),
    other = await f.product(),
    last = await f.product();
  let snapshot = await portal.read(f.a.id, 'merchant');
  const p = snapshot.products.find((p) => p.id === other)!;
  await portal.saveProduct(f.a.id, 'merchant', {
    id: other,
    title: p.title,
    description: p.description,
    category: 'Outra',
    price: p.price,
    enabled: true,
    banner: '',
    revision: snapshot.revision,
  });
  snapshot = await portal.read(f.a.id, 'merchant');
  const original = snapshot.products;
  await assert.rejects(
    () =>
      portal.moveProduct(f.a.id, 'other', {
        productId: first,
        direction: 'down',
        revision: snapshot.revision,
      }),
    { code: 'STORE_NOT_APPROVED' },
  );
  const oldRevision = snapshot.revision;
  await portal.moveProduct(f.a.id, 'merchant', {
    productId: first,
    direction: 'down',
    revision: oldRevision,
  });
  await assert.rejects(
    () =>
      portal.moveProduct(f.a.id, 'merchant', {
        productId: last,
        direction: 'down',
        revision: oldRevision,
      }),
    { code: 'STORE_CHANGED' },
  );
  snapshot = await portal.read(f.a.id, 'merchant');
  assert.deepEqual(
    snapshot.products.map((p) => p.id),
    [last, other, first],
  );
  for (const product of original)
    assert.deepEqual(
      snapshot.products.find((p) => p.id === product.id),
      product,
    );
  const categories = await f.click(222222222, 'catalog');
  const links = categories.flatMap(
    (e) =>
      (
        e.payload.reply_markup as
          | { inline_keyboard?: { text: string; callback_data: string }[][] }
          | undefined
      )?.inline_keyboard?.flat() ?? [],
  );
  const link = links.find((b) => b.text.includes('Arquivos'))!;
  const restarted = new BotStore(f.store, f.key, () => new Date('2026-10-25T12:00:00Z'));
  const result = await restarted.process(
    await restarted.authenticate(f.runtimeKey),
    f.callback(222222222, link.callback_data),
  );
  const effects = await f.effects(result.effectIds);
  const text = JSON.stringify(
    effects.find((e) => String(e.payload.text).includes('Escolha um produto'))!.payload
      .reply_markup,
  );
  assert(text.indexOf('p:' + last) < text.indexOf('p:' + first));
  await portal.moveProduct(f.a.id, 'merchant', {
    productId: last,
    direction: 'up',
    revision: (await portal.read(f.a.id, 'merchant')).revision,
  });
  assert.deepEqual(
    (await portal.read(f.a.id, 'merchant')).products.map((p) => p.id),
    [last, other, first],
  );
});

test('Catalog starts at categories even with one category; category links remain stable when sorting changes', async () => {
  const f = await fixture();
  const pid = await f.product();
  const menu = await f.click(222222222, 'catalog');
  const categoryMessage = menu.find((e) =>
    String(e.payload.text).includes('Escolha uma categoria'),
  )!;
  assert(categoryMessage);
  const rows = (
    categoryMessage.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    }
  ).inline_keyboard;
  const category = rows.flat().find((b) => b.text.includes('Arquivos'))!;
  assert(category.callback_data.startsWith('cat:'));
  assert(!rows.flat().some((b) => b.callback_data === 'p:' + pid));
  await f.store.transaction(async (tx) => {
    const key = 'bot_shops/' + f.a.id,
      shop = (await tx.get(key))!;
    shop.products.push({
      ...shop.products[0],
      id: 'abcdef012345',
      title: 'Outro catálogo',
      category: 'AAA',
    });
    tx.set(key, shop);
  });
  const items = await f.click(222222222, category.callback_data);
  const output = items.find((e) => String(e.payload.text).includes('Escolha um produto'))!;
  assert(output);
  const buttons = JSON.stringify(output.payload.reply_markup);
  assert(buttons.includes('p:' + pid));
  assert(!buttons.includes('Outro catálogo'));
  const product = (await f.click(222222222, 'p:' + pid)).find((e) =>
    String(e.payload.text).includes('Descrição do arquivo'),
  )!;
  assert(JSON.stringify(product.payload.reply_markup).includes(category.callback_data));
});

test('Merchant can create empty categories before products; existing categories stay visible and writes require owner and current revision', async () => {
  const f = await fixture(),
    portal = new MerchantConsole(f.store, f.key, f.bots);
  const snapshot = await portal.read(f.a.id, 'merchant');
  await assert.rejects(
    () => portal.createCategory(f.a.id, 'other', { name: 'Licenças', revision: snapshot.revision }),
    { code: 'STORE_NOT_APPROVED' },
  );
  await portal.createCategory(f.a.id, 'merchant', {
    name: 'Licenças',
    revision: snapshot.revision,
  });
  assert((await portal.read(f.a.id, 'merchant')).categories.includes('Licenças'));
  await assert.rejects(
    () => portal.createCategory(f.a.id, 'merchant', { name: 'Outra', revision: snapshot.revision }),
    { code: 'STORE_CHANGED' },
  );
  await f.product();
  const updated = await portal.read(f.a.id, 'merchant');
  assert(updated.categories.includes('Arquivos'));
  assert(updated.categories.includes('Licenças'));
  const buyer = await f.click(222222222, 'catalog');
  assert(!JSON.stringify(buyer).includes('Licenças'));
});

test('Transaction reads are shared only within the attempt, cloned, and superseded by buffered writes', async () => {
  const memory = new MemoryDocuments();
  await memory.transaction(async (tx) => tx.set('sample/one', { value: 1 }));
  let reads = 0;
  const store = {
    get: memory.get.bind(memory),
    list: memory.list.bind(memory),
    transaction: async <T>(
      work: (tx: import('../server/document-store.js').DocumentTransaction) => Promise<T>,
    ) =>
      memory.transaction<T>((tx) =>
        work({
          ...tx,
          get: async (key) => {
            reads++;
            return tx.get(key);
          },
        }),
      ),
  };
  await botTransaction(store, async (tx) => {
    const [a, b] = await Promise.all([tx.get('sample/one'), tx.get('sample/one')]);
    a!.value = 100;
    assert.equal(b!.value, 1);
    tx.set('sample/one', { value: 2 });
    assert.equal((await tx.get('sample/one'))!.value, 2);
  });
  assert.equal(reads, 1);
  await botTransaction(store, async (tx) => assert.equal((await tx.get('sample/one'))!.value, 2));
  assert.equal(reads, 2);
});

test('Welcome banner, caption and menu are one photo message, with text fallback when absent', async () => {
  const f = await fixture();
  await f.click(111111111, 'admin:banner');
  await photo(f, 111111111, 'WELCOME_PHOTO');
  const outputs = await f.send(222222222, '/start');
  const image = outputs.find((e) => e.method === 'sendPhoto');
  assert.equal(image?.payload.photo, 'WELCOME_PHOTO');
  assert(String(image?.payload.caption).includes('Test Shop'));
  assert(image?.payload.reply_markup);
  assert(!outputs.some((e) => e.method === 'sendMessage'));
  await f.store.transaction(async (tx) => {
    const key = 'bot_shops/' + f.a.id;
    tx.set(key, { ...(await tx.get(key)), banner: '' });
  });
  assert((await f.send(222222222, '/start')).some((e) => e.method === 'sendMessage'));
});

test('Manual Pix QR is scoped to a single full-price unit; multiple quantities, coupons and changed prices use manual data', async () => {
  for (const mode of ['single', 'quantity', 'coupon', 'changed', 'multiple'] as const) {
    const f = await fixture(true, undefined, 'merchant', '123456789', 'manual');
    const pid = await f.product();
    const portal = new MerchantConsole(f.store, f.key, f.bots);
    const snapshot = await portal.read(f.a.id, 'merchant');
    const p = snapshot.products[0];
    await portal.saveProduct(f.a.id, 'merchant', {
      id: pid,
      title: p.title,
      description: p.description,
      category: p.category,
      price: p.price,
      enabled: true,
      banner: '',
      pix_qr: 'PRODUCT_QR',
      revision: snapshot.revision,
    });
    await f.click(222222222, 'add:' + pid);
    if (mode === 'quantity') await f.click(222222222, 'add:' + pid);
    if (mode === 'multiple') {
      const other = await f.product();
      await f.click(222222222, 'add:' + other);
    }
    if (mode === 'coupon' || mode === 'changed')
      await f.store.transaction(async (tx) => {
        const root = 'bot_shops/' + f.a.id,
          shop = (await tx.get(root))!;
        if (mode === 'changed') shop.products[0].price++;
        else {
          shop.coupons.SALE = { percent: 10, limit: 5, used: 0 };
          const key = root + '/customers/222222222',
            customer = (await tx.get(key))!;
          tx.set(key, { ...customer, coupon: 'SALE' });
        }
        tx.set(root, shop);
      });
    const outputs = await f.click(222222222, 'checkout');
    const image = outputs.find((e) => e.method === 'sendPhoto' && e.payload.photo === 'PRODUCT_QR');
    assert.equal(Boolean(image), mode === 'single', mode);
    if (image) assert(image.payload.reply_markup);
    else
      assert(
        outputs.some((e) => String(e.payload.text).includes('Dados de teste')),
        mode,
      );
  }
});

async function fixture(
  activate = true,
  existing?: MemoryDocuments,
  name = 'merchant',
  botId = '123456789',
  paymentMode: 'manual' | 'stars' = 'stars',
) {
  let now = new Date('2026-10-25T12:00:00Z'),
    seq = 1;
  const store = existing ?? new MemoryDocuments(),
    key = randomBytes(32).toString('base64url');
  const p = new FirestorePlatform(store, key, async () => ({
    id: botId,
    username: 'BlackoutTestBot',
  }));
  const identity = {
    uid: name,
    email: name + '@example.test',
    emailVerified: true,
    authTime: Math.floor(Date.now() / 1000),
  };
  const a = await p.register(
    {
      name,
      email: identity.email,
      storeName: 'Test Shop',
      channel: 'telegram',
      reference: '',
      priceCents: 4990,
    },
    'admin',
  );
  await p.confirm(a.id, 'admin');
  const invite = await p.invite(a.id, 'admin');
  await p.accept(invite.token, identity);
  await p.approve(a.id, 'admin');
  await p.onboarding.save(name, {
    botToken: botId + ':' + 'A'.repeat(35),
    telegramUserId: '111111111',
  });
  let setup = (await p.onboarding.submit(name))!;
  setup = (await p.onboarding.review(a.id, 'admin', {
    action: 'configure',
    revision: setup.revision,
    note: '',
  }))!;
  const bots = new BotStore(store, key, () => now),
    runtimeKey = await bots.provision(a.id, 'square-app-' + name),
    auth = await bots.authenticate(runtimeKey);
  await store.transaction(async (tx) => {
    const shop = (await tx.get('bot_shops/' + a.id))!;
    tx.set('bot_shops/' + a.id, {
      ...shop,
      payment_mode: paymentMode,
      payment_instructions:
        paymentMode === 'manual' ? 'Dados de teste — não realizar pagamento real' : '',
    });
  });
  const message = (user: number, text: string): TelegramUpdate => ({
    update_id: seq++,
    message: { message_id: seq, from: { id: user }, chat: { id: user, type: 'private' }, text },
  });
  const callback = (user: number, data: string): TelegramUpdate => ({
    update_id: seq++,
    callback_query: {
      id: 'cb' + seq,
      from: { id: user },
      message: { chat: { id: user, type: 'private' } },
      data,
    },
  });
  const effects = async (ids: string[]) => {
    const out: BotEffect[] = [];
    for (const id of ids) {
      const effect = await bots.claim(auth, id);
      if (effect) {
        out.push(effect);
        await bots.acknowledge(auth, id, effect.lease, 'sent');
      }
    }
    return out;
  };
  const send = async (user: number, text: string) =>
    effects((await bots.process(auth, message(user, text))).effectIds);
  const click = async (user: number, data: string) =>
    effects((await bots.process(auth, callback(user, data))).effectIds);
  const bind = async () => {
    const link = await bots.ownerLink(a.id, name);
    await send(111111111, '/start ' + new URL(link.url).searchParams.get('start'));
  };
  if (activate) {
    await bind();
    await p.onboarding.activate(a.id, 'admin', {
      revision: setup.revision,
      deploymentReference: 'square-app-' + name,
    });
  }
  const product = async (units = ['LICENSE-ONE', 'LICENSE-TWO']) => {
    await send(111111111, '/admin');
    await click(111111111, 'admin:support');
    await send(111111111, '@blackout_support');
    await click(111111111, 'admin:new');
    await send(111111111, 'Arquivo de teste');
    await send(111111111, 'Descrição do arquivo');
    await send(111111111, '10');
    await send(111111111, 'Arquivos');
    const shop = (await store.get('bot_shops/' + a.id)) as Shop,
      pid = shop.products.at(-1)!.id;
    await click(111111111, 'admin:stockfor:' + pid);
    await send(111111111, units.join('\n'));
    return pid;
  };
  const order = async (user: number, pid: string) => {
    await click(user, 'add:' + pid);
    const result = await click(user, 'checkout');
    return result.find((e) => e.method === 'sendInvoice')?.payload.payload as string | undefined;
  };
  const payment = (
    user: number,
    oid: string,
    charge = 'charge-' + oid,
    total = 10,
  ): TelegramUpdate => ({
    update_id: seq++,
    message: {
      message_id: seq,
      from: { id: user },
      chat: { id: user, type: 'private' },
      successful_payment: {
        currency: 'XTR',
        total_amount: total,
        invoice_payload: oid,
        telegram_payment_charge_id: charge,
      },
    },
  });
  return {
    store,
    p,
    a,
    bots,
    auth,
    key,
    runtimeKey,
    identity,
    message,
    callback,
    send,
    click,
    effects,
    bind,
    product,
    order,
    payment,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    next: () => seq++,
  };
}

test('Bot binds Telegram owner through the authenticated merchant, once, and scopes runtime credentials to one store', async () => {
  const f = await fixture(false),
    other = await fixture(false, f.store, 'other', '223456789');
  assert.equal((await f.bots.status(f.a.id)).ownerVerified, false);
  const link = await f.bots.ownerLink(f.a.id, 'merchant'),
    argument = new URL(link.url).searchParams.get('start');
  await assert.rejects(() => f.bots.ownerLink(f.a.id, 'other'), {
    code: 'BOT_RUNTIME_UNAVAILABLE',
  });
  await f.send(222222222, '/start ' + argument);
  assert.equal((await f.bots.status(f.a.id)).ownerVerified, false);
  await f.send(111111111, '/start ' + argument);
  assert.equal((await f.bots.status(f.a.id)).ownerVerified, true);
  const reused = await f.send(111111111, '/start ' + argument);
  assert.match(String(reused[0].payload.text), /vencido/);
  assert.equal((await f.bots.configuration(f.auth)).botId, '123456789');
  assert.equal((await other.bots.configuration(other.auth)).botId, '223456789');
  await assert.rejects(() => f.bots.provision(other.a.id, 'square-app-merchant'), {
    code: 'APP_ALREADY_BOUND',
  });
  const replacement = await f.bots.provision(f.a.id, 'square-app-merchant');
  await assert.rejects(() => f.bots.authenticate(f.runtimeKey), { code: 'RUNTIME_UNAUTHORIZED' });
  await assert.rejects(() => f.bots.configuration(f.auth), { code: 'BOT_RUNTIME_UNAVAILABLE' });
  await f.bots.authenticate(replacement);
  await f.bots.revoke(f.a.id);
  await assert.rejects(() => f.bots.authenticate(replacement), { code: 'RUNTIME_UNAUTHORIZED' });
});

test('Digital catalog, coupon, cart, Stars checkout and encrypted delivery survive restarts and duplicate payment updates', async () => {
  const f = await fixture(),
    pid = await f.product();
  await f.click(111111111, 'admin:coupon');
  await f.send(111111111, 'BEMVINDO 10 5');
  await f.click(222222222, 'coupon');
  await f.send(222222222, 'BEMVINDO');
  const oid = (await f.order(222222222, pid))!;
  assert(oid);
  const orderPath = `bot_shops/${f.a.id}/orders/${oid}`;
  assert.equal((await f.store.get(orderPath))!.total, 9);
  const pre: TelegramUpdate = {
    update_id: f.next(),
    pre_checkout_query: {
      id: 'pre',
      from: { id: 222222222 },
      currency: 'XTR',
      total_amount: 9,
      invoice_payload: oid,
    },
  };
  const preEffects = await f.effects((await f.bots.process(f.auth, pre)).effectIds);
  assert.equal(preEffects[0].payload.ok, true);
  const paid = f.payment(222222222, oid, 'test-charge', 9);
  const response = await f.bots.process(f.auth, paid),
    delivery = await f.effects(response.effectIds);
  assert(delivery.some((e) => e.delivery && String(e.payload.text).includes('LICENSE-ONE')));
  assert.equal((await f.store.get(orderPath))!.status, 'delivered');
  const restarted = new BotStore(f.store, f.key);
  assert.equal((await restarted.process(f.auth, paid)).duplicate, true);
  assert.equal(await restarted.claim(f.auth, response.effectIds[0]), null);
  const again = await f.bots.process(f.auth, f.payment(222222222, oid, 'test-charge', 9));
  assert.deepEqual(again.effectIds, []);
  const stock = await f.store.get(`bot_shops/${f.a.id}/products/${pid}`);
  assert.equal(stock!.units.length, 1);
  const raw = await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 100 });
  assert(!JSON.stringify(raw).includes('LICENSE-ONE'));
  assert(!JSON.stringify(stock).includes('LICENSE-TWO'));
  await f.click(111111111, 'admin:redeliver:' + oid);
  const re = await f.click(111111111, 'admin:resend:' + oid);
  assert(re.some((e) => e.delivery && String(e.payload.text).includes('LICENSE-ONE')));
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/products/${pid}`))!.units.length, 1);
});

test('Stock transactions reject double sale of the last unit, release cancelled/expired reservations, and retain late payments for refund', async () => {
  const f = await fixture(),
    pid = await f.product(['ONLY-UNIT']);
  await f.click(222222222, 'add:' + pid);
  await f.click(333333333, 'add:' + pid);
  const results = await Promise.all([
    f.bots.process(f.auth, f.callback(222222222, 'checkout')),
    f.bots.process(f.auth, f.callback(333333333, 'checkout')),
  ]);
  const sent = (await Promise.all(results.map((r) => f.effects(r.effectIds)))).flat(),
    invoices = sent.filter((e) => e.method === 'sendInvoice');
  assert.equal(invoices.length, 1);
  const oid = invoices[0].payload.payload as string,
    buyer = Number(invoices[0].payload.chat_id);
  await f.click(buyer, 'cancel:' + oid);
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/products/${pid}`))!.units.length, 1);
  const next = (await f.order(buyer, pid))!;
  f.advance(21 * 60000);
  await f.send(buyer, '/start');
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/orders/${next}`))!.status, 'expired');
  const late = await f.effects((await f.bots.process(f.auth, f.payment(buyer, next))).effectIds);
  assert(!late.some((e) => e.delivery));
  assert.equal(
    (await f.store.get(`bot_shops/${f.a.id}/orders/${next}`))!.status,
    'refund_required',
  );
  await f.click(111111111, 'admin:refund:' + next);
  const refund = await f.click(111111111, 'admin:dorefund:' + next);
  assert.equal(refund.filter((e) => e.method === 'refundStarPayment').length, 1);
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/orders/${next}`))!.status, 'refunded');
  const duplicate = await f.click(111111111, 'admin:dorefund:' + next);
  assert(!duplicate.some((e) => e.method === 'refundStarPayment'));
});

test('Untrusted users, group chats, wrong checkout amount and expired subscriptions cannot administer or trigger deliveries', async () => {
  const f = await fixture(),
    pid = await f.product();
  const unauthorized = await f.click(222222222, 'admin:stockfor:' + pid);
  assert.match(String(unauthorized.at(-1)!.payload.text), /responsável/);
  const group = f.message(111111111, '/admin');
  group.message!.chat = { id: -123, type: 'group' };
  assert.deepEqual((await f.bots.process(f.auth, group)).effectIds, []);
  const oid = (await f.order(222222222, pid))!;
  const response = await f.effects(
    (
      await f.bots.process(f.auth, {
        update_id: f.next(),
        pre_checkout_query: {
          id: 'forged',
          from: { id: 333333333 },
          currency: 'XTR',
          total_amount: 10,
          invoice_payload: oid,
        },
      })
    ).effectIds,
  );
  assert.equal(response[0].payload.ok, false);
  const bad = await f.effects((await f.bots.process(f.auth, f.payment(333333333, oid))).effectIds);
  assert(!bad.some((e) => e.delivery));
  assert.equal(
    (await f.store.get(`bot_shops/${f.a.id}/orders/${oid}`))!.status,
    'awaiting_payment',
  );
  const expires = (await f.store.get('merchant_accounts/' + f.a.id))!;
  await f.store.transaction(async (tx) => {
    await tx.get('merchant_accounts/' + f.a.id);
    tx.set('merchant_accounts/' + f.a.id, { ...expires, paid_through: new Date(0) });
  });
  assert.equal(await f.order(444444444, pid), undefined);
  const ownOrder = await f.click(333333333, 'order:' + oid);
  assert.match(String(ownOrder.at(-1)!.payload.text), /não encontrado/);
  const traversal = await f.click(333333333, 'order:../../private/owner_link');
  assert.match(String(traversal.at(-1)!.payload.text), /não encontrado/);
});

test('Ambiguous Telegram sends are not retried automatically and cannot mark an order delivered', async () => {
  const f = await fixture(),
    pid = await f.product(),
    oid = (await f.order(222222222, pid))!;
  const paid = await f.bots.process(f.auth, f.payment(222222222, oid));
  let deliveryId = '';
  for (const id of paid.effectIds) {
    const e = await f.bots.claim(f.auth, id);
    if (e?.delivery) {
      deliveryId = id;
      await f.bots.acknowledge(f.auth, id, e.lease, 'uncertain');
    } else if (e) await f.bots.acknowledge(f.auth, id, e.lease, 'sent');
  }
  assert(deliveryId);
  assert.equal(await f.bots.claim(f.auth, deliveryId), null);
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/orders/${oid}`))!.status, 'paid');
  await assert.rejects(() => f.bots.acknowledge(f.auth, deliveryId, 'A'.repeat(32), 'sent'), {
    code: 'EFFECT_LEASE_INVALID',
  });
});

test('HTTP integration: web merchant ownership -> scoped runtime -> Telegram transport -> Stars payment -> delivery', async () => {
  const f = await fixture(false);
  await f.p.grantAdmin('admin');
  const config = {
    ...testConfig(),
    PLATFORM_DATABASE: 'firestore' as const,
    API_AUTH_MODE: 'bearer' as const,
  };
  const provider = {
    verifyIdToken: async (token: string) => {
      if (token === 'test-admin')
        return { ...f.identity, uid: 'admin', email: 'admin@example.test' };
      if (token !== 'test-merchant') throw Error();
      return f.identity;
    },
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(config, f.p, provider, undefined, {
    onboarding: f.p.onboarding,
    bots: f.bots,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    const initialSetup = (await f.p.onboarding.read(f.a.id))!;
    const activate = () =>
      fetch(origin + '/api/admin/accounts/' + f.a.id + '/bot-setup/activate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin',
          Origin: config.APP_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          revision: initialSetup.revision,
          deploymentReference: 'square-app-merchant',
          botTested: true,
          ownerIdConfirmed: true,
        }),
      });
    assert.equal((await activate()).status, 409);
    const api = new BotRuntimeApi(origin, f.runtimeKey, fetch, true),
      captured: { method: string; payload: any }[] = [];
    const telegram = new TelegramClient('123456789:' + 'A'.repeat(35), (async (url, opts) => {
      captured.push({
        method: String(url).split('/').at(-1)!,
        payload: JSON.parse(opts!.body as string),
      });
      return Response.json({ ok: true, result: { message_id: 10 } });
    }) as typeof fetch);
    assert.equal((await fetch(origin + '/internal/bot/config')).status, 401);
    assert.equal(
      (
        await fetch(origin + '/internal/bot/config', {
          headers: { Authorization: 'Bearer ' + f.runtimeKey, Origin: config.APP_ORIGIN },
        })
      ).status,
      403,
    );
    const linkResponse = await fetch(origin + '/api/store/telegram-link', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-merchant',
        Origin: config.APP_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(linkResponse.status, 200);
    const link = await linkResponse.json();
    await processTelegramUpdate(
      api,
      telegram,
      f.message(111111111, '/start ' + new URL(link.url).searchParams.get('start')),
    );
    assert.equal((await activate()).status, 200);
    const pid = await f.product(),
      oid = (await f.order(222222222, pid))!;
    await processTelegramUpdate(api, telegram, f.payment(222222222, oid));
    assert(
      captured.some((v) => v.method === 'sendMessage' && v.payload.text.includes('LICENSE-ONE')),
    );
    assert.equal((await f.store.get(`bot_shops/${f.a.id}/orders/${oid}`))!.status, 'delivered');
    const web = await fetch(origin + '/api/store/runtime', {
      headers: { Authorization: 'Bearer test-merchant' },
    });
    assert.equal((await web.json()).runtime.ownerVerified, true);
    const otherKey = 'botr_' + f.a.id + '_' + 'Z'.repeat(43);
    await assert.rejects(
      () => new BotRuntimeApi(origin, otherKey, fetch, true).call('/config'),
      RuntimeApiError,
    );
    await dispatchEffects(api, telegram, (await api.call<{ ids: string[] }>('/effects')).ids);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('Telegram transport never exposes the token in network or provider errors', async () => {
  const token = '123456789:' + 'A'.repeat(35),
    client = new TelegramClient(token, (async () => {
      throw Error('leaked request ' + token);
    }) as typeof fetch);
  await assert.rejects(
    () => client.call('getMe'),
    (e: unknown) => e instanceof TelegramError && !String(e.stack).includes(token),
  );
});

test('Monthly renewal is idempotent, reminders are durable, and expired invoices cannot be sent', async () => {
  const f = await fixture(),
    pid = await f.product(),
    oid = (await f.order(222222222, pid))!;
  f.advance(21 * 60000);
  const stale = f.callback(333333333, 'home');
  await f.bots.process(f.auth, stale);
  const accountPath = 'merchant_accounts/' + f.a.id,
    account = (await f.store.get(accountPath))!;
  await f.store.transaction(async (tx) => {
    await tx.get(accountPath);
    tx.set(accountPath, { ...account, paid_through: new Date('2026-10-26T12:00:00Z') });
  });
  await f.bots.tick(f.auth);
  await f.bots.tick(f.auth);
  const reminders = (await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 100 })).filter(
    (v) => v.id.startsWith('r'),
  );
  assert.equal(reminders.length, 1);
  const request = '12345678-1234-4234-8234-123456789012';
  const first = await f.bots.renew(f.a.id, 'admin', request),
    again = await f.bots.renew(f.a.id, 'admin', request);
  assert.deepEqual(first, again);
  assert.equal(first.paidThrough.toISOString(), '2026-11-26T12:00:00.000Z');
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/orders/${oid}`))!.status, 'expired');
});

test('File inventory is encrypted, delivered as a document, and refund cancels pending deliveries', async () => {
  const f = await fixture(),
    pid = await f.product(['TEXT']);
  await f.click(111111111, 'admin:stockfor:' + pid);
  const update = f.message(111111111, '');
  delete update.message!.text;
  update.message!.document = { file_id: 'PRIVATE-FILE-ID', file_name: 'digital.pdf' };
  await f.effects((await f.bots.process(f.auth, update)).effectIds);
  const first = (await f.order(222222222, pid))!;
  await f.click(222222222, 'cancel:' + first);
  // Cancellation appends the reserved text after the document, so the next order gets the file.
  const oid = (await f.order(222222222, pid))!;
  const result = await f.bots.process(f.auth, f.payment(222222222, oid));
  const raw = await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 100 });
  assert(!JSON.stringify(raw).includes('PRIVATE-FILE-ID'));
  const fileDelivery = await f.effects(result.effectIds);
  assert(
    fileDelivery.some(
      (e) => e.method === 'sendDocument' && e.payload.document === 'PRIVATE-FILE-ID',
    ),
  );
  const second = (await f.order(222222222, pid))!;
  const secondResult = await f.bots.process(f.auth, f.payment(222222222, second));
  await f.click(111111111, 'admin:refund:' + second);
  await f.click(111111111, 'admin:dorefund:' + second);
  const delivered = await f.effects(secondResult.effectIds);
  assert(!delivered.some((e) => e.delivery));
});

type BotFixture = Awaited<ReturnType<typeof fixture>>;
async function photo(f: BotFixture, user: number, fileId: string) {
  const update = f.message(user, '');
  delete update.message!.text;
  update.message!.photo = [{ file_id: fileId }];
  return f.effects((await f.bots.process(f.auth, update)).effectIds);
}
async function manualCheckout(f: BotFixture, user: number, pid: string, name = 'Ana Compradora') {
  await f.click(user, 'add:' + pid);
  const update = f.callback(user, 'checkout');
  update.callback_query!.from.first_name = name;
  update.callback_query!.from.username = 'ana_cliente';
  await f.effects((await f.bots.process(f.auth, update)).effectIds);
  return (await f.store.get(`bot_shops/${f.a.id}/customers/${user}`))!.orders[0] as string;
}
async function notice(f: BotFixture, text = 'Novidades da loja') {
  await f.click(111111111, 'admin:notice-new');
  await f.send(111111111, text);
  await f.click(111111111, 'admin:notice-no-photo');
  return (await f.store.get('bot_shops/' + f.a.id))!.notice_recent[0] as string;
}

test('Product photo is optional, editable and removable; support has independent name, phone and HTTPS link; BotFather name is synchronized', async () => {
  const f = await fixture(),
    pid = await f.product();
  let view = await f.click(222222222, 'p:' + pid);
  assert(
    view.some(
      (e) => e.method === 'sendMessage' && String(e.payload.text).includes('Arquivo de teste'),
    ),
  );
  await f.click(111111111, 'admin:productbanner:' + pid);
  await photo(f, 111111111, 'PRODUCT-BANNER');
  view = await f.click(222222222, 'p:' + pid);
  assert(
    view.some(
      (e) =>
        e.method === 'sendPhoto' &&
        e.payload.photo === 'PRODUCT-BANNER' &&
        String(e.payload.caption).includes('10 ⭐') &&
        Boolean(e.payload.reply_markup),
    ),
  );
  await f.click(111111111, 'admin:productbanner:' + pid);
  await f.send(111111111, 'remover');
  view = await f.click(222222222, 'p:' + pid);
  assert(!view.some((e) => e.method === 'sendPhoto'));
  for (const [field, value] of [
    ['name', 'Atendimento Blackout'],
    ['phone', '+55 (11) 99999-0000'],
    ['url', 'https://wa.me/5511999990000'],
  ]) {
    await f.click(111111111, 'admin:support-' + field);
    await f.send(111111111, value);
  }
  const support = await f.click(222222222, 'support'),
    response = support.find((e) => e.method === 'sendMessage')!;
  assert.match(String(response.payload.text), /Atendimento Blackout/);
  assert.match(String(response.payload.text), /99999-0000/);
  assert(JSON.stringify(response.payload.reply_markup).includes('https://wa.me/5511999990000'));
  await f.click(111111111, 'admin:support-url');
  await f.send(111111111, 'javascript:alert(1)');
  assert.equal(
    (await f.store.get('bot_shops/' + f.a.id))!.support_url,
    'https://wa.me/5511999990000',
  );
  await f.bots.tick(f.auth, 'Nome configurado no BotFather');
  const home = await f.send(222222222, '/start');
  assert(home.some((e) => String(e.payload.text).includes('Nome configurado no BotFather')));
});

test('Manual receipt is encrypted, reaches the owner with customer and items, and approval delivers once with correct buyer statistics', async () => {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual'),
    pid = await f.product(['CODE-A', 'CODE-B']);
  const oid = await manualCheckout(f, 222222222, pid),
    orderPath = `bot_shops/${f.a.id}/orders/${oid}`;
  const before = await f.click(222222222, 'order:' + oid);
  assert(
    before.some(
      (e) =>
        String(e.payload.text).includes('Arquivo de teste') &&
        String(e.payload.text).includes('Aguardando pagamento') &&
        String(e.payload.text).includes('10,00'),
    ),
  );
  assert(!before.some((e) => e.delivery));
  await f.click(222222222, 'receipt:' + oid);
  const forwarded = await photo(f, 222222222, 'SECRET-RECEIPT');
  assert(
    forwarded.some(
      (e) =>
        e.method === 'sendPhoto' &&
        e.payload.chat_id === '111111111' &&
        e.payload.photo === 'SECRET-RECEIPT',
    ),
  );
  assert(
    forwarded.some(
      (e) =>
        e.payload.chat_id === '111111111' &&
        String(e.payload.text).includes('Ana Compradora') &&
        String(e.payload.text).includes('Arquivo de teste'),
    ),
  );
  assert.equal((await f.store.get(orderPath))!.status, 'awaiting_review');
  assert(!JSON.stringify(await f.store.get(orderPath)).includes('SECRET-RECEIPT'));
  const unauthorized = await f.click(333333333, `admin:review-approve:${oid}:1`);
  assert(!unauthorized.some((e) => e.delivery));
  assert.equal((await f.store.get(orderPath))!.status, 'awaiting_review');
  const approved = await f.click(111111111, `admin:review-approve:${oid}:1`);
  assert(approved.some((e) => e.delivery && String(e.payload.text).includes('CODE-A')));
  assert.equal((await f.store.get(orderPath))!.status, 'delivered');
  assert(!(await f.click(111111111, `admin:review-approve:${oid}:1`)).some((e) => e.delivery));
  const shop = (await f.store.get('bot_shops/' + f.a.id))!;
  assert.equal(shop.stats.buyers, 1);
  assert.equal(shop.stats.paid_orders, 1);
  assert.equal(shop.stats.delivered_orders, 1);
  assert.equal(shop.stats.gross_brl, 1000);
  assert.deepEqual(shop.review_orders, []);
  const buyer = await f.click(111111111, 'admin:buyer:222222222');
  assert(
    buyer.some(
      (e) =>
        String(e.payload.text).includes('Ana Compradora') &&
        String(e.payload.text).includes('Compras aprovadas: 1'),
    ),
  );
});

test('Replaced receipts reject stale approvals; owner denial requires a reason and releases inventory without delivery', async () => {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual'),
    pid = await f.product(['ONLY-CODE']),
    oid = await manualCheckout(f, 222222222, pid);
  await f.click(333333333, 'receipt:' + oid);
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/customers/333333333`))!.session, null);
  await f.click(222222222, 'receipt:' + oid);
  await photo(f, 222222222, 'OLD-RECEIPT');
  await f.click(222222222, 'receipt:' + oid);
  await photo(f, 222222222, 'NEW-RECEIPT');
  assert(!(await f.click(111111111, `admin:review-approve:${oid}:1`)).some((e) => e.delivery));
  await f.click(111111111, `admin:review-reject:${oid}:2`);
  const denied = await f.send(111111111, 'Pagamento não localizado no extrato');
  assert(
    denied.some(
      (e) =>
        e.payload.chat_id === '222222222' &&
        String(e.payload.text).includes('Pagamento não localizado'),
    ),
  );
  assert(!denied.some((e) => e.delivery));
  const order = (await f.store.get(`bot_shops/${f.a.id}/orders/${oid}`))!;
  assert.equal(order.status, 'rejected');
  assert.equal(order.reviewed_by, '111111111');
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/products/${pid}`))!.units.length, 1);
  const summary = await f.click(111111111, 'admin:stats');
  assert(summary.some((e) => String(e.payload.text).includes('Recusados: 1')));
  const buyerView = await f.click(222222222, 'order:' + oid);
  assert(
    buyerView.some(
      (e) =>
        String(e.payload.text).includes('Pagamento recusado') &&
        String(e.payload.text).includes('Arquivo de teste'),
    ),
  );
});

test('Full purchase history paginates beyond recent orders and stays private to each buyer', async () => {
  const f = await fixture();
  await f.store.transaction(async (tx) => {
    await tx.get('bot_shops/' + f.a.id);
    for (let i = 1; i <= 32; i++) {
      const id = i.toString(16).padStart(16, '0');
      tx.set(`bot_shops/${f.a.id}/orders/${id}`, {
        id,
        buyer_id: '222222222',
        items: [{ title: 'Produto histórico ' + i, quantity: 1, product_id: 'history', units: [] }],
        total: 100,
        currency: 'BRL',
        status: 'delivered',
        coupon: '',
        created_at: new Date(),
        expires_at: new Date(),
      });
    }
    tx.set(`bot_shops/${f.a.id}/orders/ffffffffffffffff`, {
      id: 'ffffffffffffffff',
      buyer_id: '333333333',
      items: [],
      total: 100,
      status: 'delivered',
      created_at: new Date(),
    });
  });
  const seen = new Set<string>();
  let cursor = '';
  for (let page = 0; page < 3; page++) {
    const result = await f.click(222222222, 'history:' + cursor);
    for (const effect of result) {
      const markup = effect.payload.reply_markup as
        | { inline_keyboard?: { callback_data?: string }[][] }
        | undefined;
      for (const row of markup?.inline_keyboard ?? [])
        for (const button of row) {
          if (button.callback_data?.startsWith('order:')) seen.add(button.callback_data.slice(6));
          if (button.callback_data?.startsWith('history:')) cursor = button.callback_data.slice(8);
        }
    }
  }
  assert.equal(seen.size, 32);
  assert(!seen.has('ffffffffffffffff'));
  const invalid = await f.click(222222222, 'history:../../private');
  assert(invalid.some((e) => String(e.payload.text).includes('Página inválida')));
});

test('Announcements require owner confirmation, page through subscribers exactly once, persist across restart and stay within the store', async () => {
  const f = await fixture();
  for (let i = 0; i < 25; i++) await f.click(200000000 + i, 'notices:subscribe');
  await f.store.transaction(async (tx) => {
    await tx.get('bot_shops/other');
    tx.set('bot_shops/other/subscribers/999999999', {
      id: '999999999',
      enabled: true,
      subscribed_at: new Date(0),
    });
  });
  const nid = await notice(f, 'Novidade privada da loja');
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/announcements/${nid}`))!.status, 'draft');
  await f.click(222222222, 'admin:notice-send:' + nid);
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/announcements/${nid}`))!.status, 'draft');
  await f.click(111111111, 'admin:notice-send:' + nid);
  await f.click(111111111, 'admin:notice-send:' + nid);
  const first = await Promise.all([f.bots.pending(f.auth), f.bots.pending(f.auth)]);
  const deliveries = await f.effects([...new Set(first.flat())]);
  const restarted = new BotStore(f.store, f.key);
  const second = await restarted.pending(f.auth);
  deliveries.push(...(await f.effects(second)));
  const sent = deliveries.filter((e) => e.announcement_id === nid);
  assert.equal(sent.length, 25);
  assert.equal(new Set(sent.map((e) => e.payload.chat_id)).size, 25);
  assert(!sent.some((e) => e.payload.chat_id === '999999999'));
  const record = (await f.store.get(`bot_shops/${f.a.id}/announcements/${nid}`))!;
  assert.equal(record.status, 'completed');
  assert.equal(record.sent, 25);
  const raw = await f.store.list(`bot_shops/${f.a.id}/effects`, { limit: 500 });
  assert(!JSON.stringify(raw).includes('Novidade privada da loja'));
});

test('Announcement unsubscribe and cancellation stop queued messages; 429 can retry and blocked recipients are disabled', async () => {
  const f = await fixture();
  await f.click(222222222, 'notices:subscribe');
  await f.click(333333333, 'notices:subscribe');
  const nid = await notice(f);
  await f.click(111111111, 'admin:notice-send:' + nid);
  await f.bots.pending(f.auth);
  await f.click(222222222, 'notices:unsubscribe');
  assert.equal(await f.bots.claim(f.auth, `n${nid}_222222222`), null);
  const id = `n${nid}_333333333`,
    effect = await f.bots.claim(f.auth, id);
  assert(effect);
  await f.bots.acknowledge(f.auth, id, effect.lease, 'retry', 429, 30);
  assert.equal(await f.bots.claim(f.auth, id), null);
  f.advance(31000);
  const retry = await f.bots.claim(f.auth, id);
  assert(retry);
  await f.bots.acknowledge(f.auth, id, retry.lease, 'failed', 403);
  const record = (await f.store.get(`bot_shops/${f.a.id}/announcements/${nid}`))!;
  assert.equal(record.failed, 1);
  assert.equal(record.skipped, 1);
  assert.equal(record.uncertain, 0);
  assert.equal(record.status, 'completed');
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/subscribers/333333333`))!.enabled, false);
  await f.click(444444444, 'notices:subscribe');
  const cancelled = await notice(f, 'Aviso cancelado');
  await f.click(111111111, 'admin:notice-send:' + cancelled);
  await f.bots.pending(f.auth);
  await f.click(111111111, 'admin:notice-cancel:' + cancelled);
  assert.equal(await f.bots.claim(f.auth, `n${cancelled}_444444444`), null);
});

test('Web console edits the same catalog and stock as Telegram, rejects stale edits and never exposes inventory secrets', async () => {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual'),
    portal = new MerchantConsole(f.store, f.key, f.bots);
  const initial = await portal.read(f.a.id, 'merchant');
  const created = await portal.saveProduct(f.a.id, 'merchant', {
    title: 'Produto pelo site',
    description: 'Descrição criada pelo painel',
    category: 'Licenças',
    price: 1250,
    enabled: true,
    banner: '',
    revision: initial.revision,
  });
  await assert.rejects(
    () =>
      portal.saveProduct(f.a.id, 'merchant', {
        title: 'Outra tela',
        description: 'Texto',
        category: 'Licenças',
        price: 1000,
        enabled: true,
        banner: '',
        revision: initial.revision,
      }),
    { code: 'STORE_CHANGED' },
  );
  const request = {
    productId: created.id,
    units: ['WEB-STOCK-PRIVATE-ONE', 'WEB-STOCK-PRIVATE-TWO'],
    requestId: randomBytes(16).toString('hex'),
  };
  request.requestId = '12345678-1234-4234-8234-123456789012';
  await portal.addStock(f.a.id, 'merchant', request);
  await portal.addStock(f.a.id, 'merchant', request);
  const snapshot = await portal.read(f.a.id, 'merchant');
  assert.equal(snapshot.products[0].stock, 2);
  assert(!JSON.stringify(snapshot).includes('WEB-STOCK-PRIVATE'));
  await assert.rejects(() => portal.read(f.a.id, 'other'), { code: 'STORE_NOT_APPROVED' });
  const view = await f.click(222222222, 'p:' + created.id);
  assert(
    view.some(
      (e) =>
        String(e.payload.text).includes('Produto pelo site') &&
        String(e.payload.text).includes('12,50'),
    ),
  );
  await portal.saveSettings(f.a.id, 'merchant', {
    welcome: 'Entrada editada pelo site',
    banner: '',
    support: '',
    support_name: 'Equipe da loja',
    support_phone: '+5511999990000',
    support_url: 'https://example.com/atendimento',
    payment_instructions: 'PIX DE TESTE — NÃO PAGAR',
    revision: (await portal.read(f.a.id, 'merchant')).revision,
  });
  assert(
    (await f.send(222222222, '/start')).some((e) =>
      String(e.payload.text).includes('Entrada editada pelo site'),
    ),
  );
  const support = await f.click(222222222, 'support');
  assert(support.some((e) => String(e.payload.text).includes('Equipe da loja')));
});

test('Web approval and announcements reuse domain checks without changing Telegram offsets or duplicating deliveries', async () => {
  const f = await fixture(true, undefined, 'merchant', '123456789', 'manual'),
    pid = await f.product(),
    portal = new MerchantConsole(f.store, f.key, f.bots),
    oid = await manualCheckout(f, 222222222, pid);
  await f.click(222222222, 'receipt:' + oid);
  await photo(f, 222222222, 'WEB-RECEIPT');
  const before = (await f.store.get('bot_runtimes/' + f.a.id))!.offset;
  const command = {
    command: `admin:review-approve:${oid}:1`,
    requestId: '12345678-1234-4234-8234-123456789012',
  };
  await assert.rejects(() => portal.command(f.a.id, 'other', command), {
    code: 'STORE_NOT_APPROVED',
  });
  await portal.command(f.a.id, 'merchant', command);
  await portal.command(f.a.id, 'merchant', command);
  assert.equal((await f.store.get('bot_runtimes/' + f.a.id))!.offset, before);
  assert.equal((await f.store.get(`bot_shops/${f.a.id}/orders/${oid}`))!.status, 'paid');
  const page = await portal.orders(f.a.id, 'merchant');
  assert(!JSON.stringify(page).includes('receipt_ciphertext'));
  assert(!JSON.stringify(page).includes('LICENSE-ONE'));
  assert.equal(page.orders[0].hasReceipt, true);
  await assert.rejects(
    () =>
      portal.command(f.a.id, 'merchant', {
        ...command,
        requestId: '22345678-1234-4234-8234-123456789012',
      }),
    { code: 'RECEIPT_CHANGED' },
  );
  await f.click(333333333, 'notices:subscribe');
  const draft = await portal.draft(f.a.id, 'merchant', {
    text: 'Aviso criado no site',
    photo: '',
    requestId: '32345678-1234-4234-8234-123456789012',
  });
  await portal.command(f.a.id, 'merchant', {
    command: 'admin:notice-send:' + draft.id,
    requestId: '42345678-1234-4234-8234-123456789012',
  });
  const pending = await f.bots.pending(f.auth);
  const effects = await f.effects(pending);
  assert(
    effects.some(
      (e) => e.announcement_id === draft.id && e.payload.text === 'Aviso criado no site',
    ),
  );
});

test('Web HTTP authorization derives the shop from Firebase, blocks suspension and rejects caller-supplied shop IDs', async () => {
  const f = await fixture(),
    cfg = {
      ...testConfig(),
      PLATFORM_DATABASE: 'firestore' as const,
      API_AUTH_MODE: 'bearer' as const,
      BOT_TOKEN_ENCRYPTION_KEY: f.key,
    };
  const auth = {
    verifyIdToken: async (token: string) => {
      if (token !== 'merchant') throw Error();
      return f.identity;
    },
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(cfg, f.p, auth, undefined, {
    onboarding: f.p.onboarding,
    bots: f.bots,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    headers = {
      Authorization: 'Bearer merchant',
      Origin: cfg.APP_ORIGIN,
      'Content-Type': 'application/json',
    };
  try {
    assert.equal((await fetch(origin + '/api/store/manage')).status, 401);
    const r = await fetch(origin + '/api/store/manage', { headers });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert(Array.isArray(d.products));
    const bad = await fetch(origin + '/api/store/manage/products', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountId: 'another-shop',
        title: 'A',
        description: 'B',
        category: 'C',
        price: 1,
        enabled: true,
        banner: '',
        revision: d.revision,
      }),
    });
    assert.equal(bad.status, 400);
    const media = await fetch(origin + '/api/store/manage/media', {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: 'data:image/png;base64,AAAA' }),
    });
    assert.equal(media.status, 400);
    await f.p.suspend(f.a.id, 'Pausado para teste', 'admin');
    assert.equal((await fetch(origin + '/api/store/manage', { headers })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
