import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryDocuments } from './document-memory.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { BotStore } from '../server/bot-store.js';
import { AutomaticActivation } from '../server/automatic-activation.js';
import { HostingError, SquareHosting, runtimeZip } from '../server/square-hosting.js';
import { createApp } from '../server/app.js';
import { testConfig } from './helpers.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { adminPath } from '../server/firestore-platform.js';

async function fixture() {
  const store = new MemoryDocuments(),
    key = randomBytes(32).toString('base64url');
  const platform = new FirestorePlatform(store, key, async () => ({
    id: '123456789',
    username: 'TestBlackoutBot',
  }));
  const account = await platform.register(
    {
      name: 'Merchant',
      email: 'merchant@example.test',
      storeName: 'Store',
      channel: 'site',
      reference: 'paid checkout',
      priceCents: 2450,
    },
    'admin',
  );
  await platform.confirm(account.id, 'admin');
  const invite = await platform.invite(account.id, 'admin');
  await platform.accept(invite.token, {
    uid: 'merchant',
    email: account.email,
    emailVerified: true,
    authTime: Date.now() / 1000,
  });
  await platform.approve(account.id, 'admin');
  await store.transaction(async (tx) => {
    const a = (await tx.get('merchant_accounts/' + account.id))!;
    tx.set('merchant_accounts/' + account.id, { ...a, billing_months: 3 });
  });
  await platform.onboarding.save('merchant', {
    botToken: '123456789:' + 'A'.repeat(35),
    telegramUserId: '111111111',
  });
  await platform.onboarding.submit('merchant');
  const bots = new BotStore(store, key);
  const apps: { id: string; name: string }[] = [];
  let available = 512,
    uploads = 0,
    webhook = false,
    loseUpload = false,
    envFails = false;
  const envs: Record<string, string>[] = [];
  const provider = {
    account: async () => ({ available, apps }),
    upload: async (_archive: Uint8Array) => {
      uploads++;
      apps.push({ id: 'a'.repeat(32), name: 'Blackout-' + account.id });
      if (loseUpload) throw new HostingError('NETWORK', true);
      return apps[0].id;
    },
    configure: async (_id: string, env: Record<string, string>) => {
      if (envFails) throw new HostingError('MISSING_SCOPE');
      envs.push(env);
    },
    running: async () => true,
  };
  const activation = new AutomaticActivation(
    bots,
    platform.onboarding,
    key,
    'https://api.example.test',
    () => provider,
    async () => ({ id: '123456789', webhook }),
    async () => Buffer.from('test archive'),
  );
  await activation.connect('admin', {
    apiKey: 'test-private-key-' + 'A'.repeat(30),
    enabled: true,
  });
  await activation.enqueue(account.id);
  const tick = async () => {
    await activation.tick();
    await activation.tick();
  };
  return {
    store,
    key,
    account,
    platform,
    bots,
    activation,
    apps,
    envs,
    tick,
    uploads: () => uploads,
    capacity: (v: number) => {
      available = v;
    },
    webhook: () => {
      webhook = true;
    },
    loseUpload: () => {
      loseUpload = true;
    },
    envFails: (v: boolean) => {
      envFails = v;
    },
  };
}
test('Automatic activation provisions one isolated app, waits for verified owner and starts the contracted period once', async () => {
  const f = await fixture();
  await Promise.all([f.activation.tick(), f.activation.tick()]);
  assert.equal(f.uploads(), 1);
  assert.equal((await f.activation.status(f.account.id))?.stage, 'waiting_owner');
  assert.equal((await f.store.get('merchant_accounts/' + f.account.id))!.billing_started_at, null);
  const env = f.envs[0];
  assert.deepEqual(Object.keys(env).sort(), [
    'BOT_API_ORIGIN',
    'BOT_RUNTIME_KEY',
    'NODE_ENV',
    'PORT',
  ]);
  const auth = await f.bots.authenticate(env.BOT_RUNTIME_KEY);
  await f.bots.tick(auth);
  await f.tick();
  assert.equal((await f.activation.status(f.account.id))?.stage, 'waiting_owner');
  const link = await f.bots.ownerLink(f.account.id, 'merchant');
  const start = new URL(link.url).searchParams.get('start');
  const update = (user: number, seq: number) => ({
    update_id: seq,
    message: {
      message_id: seq,
      from: { id: user },
      chat: { id: user, type: 'private' },
      text: '/start ' + start,
    },
  });
  await f.bots.process(auth, update(222222222, 1));
  assert.equal((await f.bots.status(f.account.id)).ownerVerified, false);
  await f.bots.process(auth, update(111111111, 2));
  await f.tick();
  assert.equal((await f.activation.status(f.account.id))?.stage, 'active');
  const active = (await f.store.get('merchant_accounts/' + f.account.id))!;
  assert(active.paid_through.getTime() - active.billing_started_at.getTime() > 80 * 86400000);
  await f.tick();
  assert.equal(f.uploads(), 1);
  assert.deepEqual(
    (await f.store.get('merchant_accounts/' + f.account.id))!.paid_through,
    active.paid_through,
  );
  assert.equal(
    (await f.store.get('bot_activation_jobs/' + f.account.id))!.runtime_key_ciphertext,
    null,
  );
});
test('Insufficient capacity preserves payment and billing dates; retry safely proceeds after capacity is freed', async () => {
  const f = await fixture();
  f.capacity(30);
  await f.tick();
  assert.equal(f.uploads(), 0);
  assert.equal((await f.activation.status(f.account.id))?.code, 'INSUFFICIENT_MEMORY');
  assert.equal((await f.store.get('merchant_accounts/' + f.account.id))!.billing_started_at, null);
  f.capacity(256);
  await f.activation.retry(f.account.id);
  await f.tick();
  assert.equal(f.uploads(), 1);
});
test('Lost upload response reconciles existing app by unique account name without another POST', async () => {
  const f = await fixture();
  f.loseUpload();
  await f.tick();
  assert.equal((await f.activation.status(f.account.id))?.stage, 'uncertain');
  await f.activation.retry(f.account.id);
  await f.tick();
  assert.equal((await f.activation.status(f.account.id))?.stage, 'waiting_owner');
  assert.equal(f.uploads(), 1);
});
test('Ambiguous upload with no matching app never blindly resubmits', async () => {
  const f = await fixture();
  f.loseUpload();
  await f.tick();
  f.apps.length = 0;
  await f.activation.retry(f.account.id);
  await f.tick();
  assert.equal((await f.activation.status(f.account.id))?.stage, 'uncertain');
  assert.equal(f.uploads(), 1);
});
test('Private environment failure retries same runtime key and never creates a second app', async () => {
  const f = await fixture();
  f.envFails(true);
  await f.tick();
  const runtime = await f.store.get('bot_runtimes/' + f.account.id);
  f.envFails(false);
  await f.activation.retry(f.account.id);
  await f.tick();
  assert.equal(f.uploads(), 1);
  assert.equal(
    (await f.store.get('bot_runtimes/' + f.account.id))!.generation,
    runtime!.generation,
  );
  assert.equal((await f.activation.status(f.account.id))?.stage, 'waiting_owner');
});
test('Existing webhook, suspended accounts and revoked contract prevent deployment', async () => {
  const webhook = await fixture();
  webhook.webhook();
  await webhook.tick();
  assert.equal(webhook.uploads(), 0);
  assert.equal((await webhook.activation.status(webhook.account.id))?.code, 'EXISTING_WEBHOOK');
  const suspended = await fixture();
  await suspended.platform.suspend(suspended.account.id, 'admin', 'Test suspension');
  await suspended.tick();
  assert.equal(suspended.uploads(), 0);
});
test('Hosting keys are encrypted and never returned in public settings/status', async () => {
  const f = await fixture();
  const settings = await f.store.get('platform_hosting/squarecloud');
  assert(!JSON.stringify(settings).includes('test-private-key'));
  assert.deepEqual(await f.activation.settings(), {
    connected: true,
    enabled: true,
    memoryPerBot: 256,
  });
  await f.activation.pause();
  await f.tick();
  assert.equal(f.uploads(), 0);
});
test('Square adapter uses official multipart/env contracts without exposing provider bodies', async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const api = new SquareHosting('PRIVATE_TEST', async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    if (path.endsWith('/users/me'))
      return Response.json({
        status: 'success',
        response: { user: { plan: { memory: { available: 256 } } }, applications: [] },
      });
    if (path === '/v2/apps')
      return Response.json({ status: 'success', response: { id: 'b'.repeat(32) } });
    return Response.json({ status: 'success', response: { running: true } });
  });
  assert.equal((await api.account()).available, 256);
  const id = await api.upload(runtimeZip({ 'package.json': '{}' }));
  assert(calls[1].init!.body instanceof FormData);
  await api.configure(id, { BOT_RUNTIME_KEY: 'PRIVATE_RUNTIME' });
  assert.deepEqual(JSON.parse(String(calls[2].init!.body)), {
    envs: { BOT_RUNTIME_KEY: 'PRIVATE_RUNTIME' },
  });
  assert(calls[3].path.endsWith('/restart'));
  assert(await api.running(id));
});

test('Hosting HTTP settings require administrator MFA and merchant tracking cannot select another account', async () => {
  const f = await fixture();
  await f.store.transaction(async (tx) => {
    tx.set(adminPath('admin'), { firebase_uid: 'admin' });
  });
  const config = {
    ...testConfig(),
    PLATFORM_DATABASE: 'firestore' as const,
    API_AUTH_MODE: 'bearer' as const,
    BOT_TOKEN_ENCRYPTION_KEY: f.key,
    ADMIN_MFA_REQUIRED: true,
  };
  const auth = {
    verifyIdToken: async (token: string) => ({
      uid: token === 'admin-mfa' ? 'admin' : token,
      email: 'merchant@example.test',
      emailVerified: true,
      authTime: Date.now() / 1000,
      secondFactor: token === 'admin-mfa',
    }),
    verifySession: async () => {
      throw Error();
    },
    createSession: async () => '',
  };
  const server = createApp(config, f.platform, auth, undefined, {
    onboarding: f.platform.onboarding,
    bots: f.bots,
    activation: f.activation,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = (path: string, user?: string) =>
    fetch(origin + path, {
      headers: user ? { Authorization: 'Bearer ' + user, Origin: config.APP_ORIGIN } : {},
    });
  try {
    assert.equal((await request('/api/admin/hosting')).status, 401);
    assert.equal((await request('/api/admin/hosting', 'merchant')).status, 403);
    assert.equal((await request('/api/admin/hosting', 'admin')).status, 403);
    const permitted = await request('/api/admin/hosting', 'admin-mfa');
    assert.equal(permitted.status, 200);
    assert(!JSON.stringify(await permitted.json()).includes('ciphertext'));
    assert.equal((await request('/api/store/runtime', 'stranger')).status, 403);
    const mine = await request('/api/store/runtime?accountId=someone-else', 'merchant');
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).activation.stage, 'queued');
    assert.equal(
      (await request('/api/admin/accounts/' + f.account.id + '/activation', 'merchant')).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
