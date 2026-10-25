import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MemoryDocuments } from './document-memory.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { BotStore } from '../server/bot-store.js';
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

async function fixture(
  activate = true,
  existing?: MemoryDocuments,
  name = 'merchant',
  botId = '123456789',
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
      if(token==='test-admin')return {...f.identity,uid:'admin',email:'admin@example.test'};
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
    const initialSetup=(await f.p.onboarding.read(f.a.id))!;
    const activate=()=>fetch(origin+'/api/admin/accounts/'+f.a.id+'/bot-setup/activate',{method:'POST',headers:{Authorization:'Bearer test-admin',Origin:config.APP_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({revision:initialSetup.revision,deploymentReference:'square-app-merchant',botTested:true,ownerIdConfirmed:true})});
    assert.equal((await activate()).status,409);
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
    assert.equal((await activate()).status,200);
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
  const fileDelivery=await f.effects(result.effectIds);
  assert(fileDelivery.some(e=>e.method==='sendDocument'&&e.payload.document==='PRIVATE-FILE-ID'));
  const second=(await f.order(222222222,pid))!;
  const secondResult=await f.bots.process(f.auth,f.payment(222222222,second));
  await f.click(111111111, 'admin:refund:' + second);
  await f.click(111111111, 'admin:dorefund:' + second);
  const delivered = await f.effects(secondResult.effectIds);
  assert(!delivered.some((e) => e.delivery));
});
