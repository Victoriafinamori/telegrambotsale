import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testConfig } from './helpers.js';
import type { AccountService, OnboardingService } from '../server/platform-contract.js';
import type { IdentityProvider } from '../server/types.js';
test('Public health and static configuration never touch the database during normal operation',async()=>{
  let calls=0;
  const accounts=new Proxy({} as AccountService,{get:()=>()=>{calls++;throw Error('Database unavailable');}});
  const server=createApp(testConfig(),accounts,{} as IdentityProvider,undefined,{onboarding:{} as OnboardingService}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  try {
    for(const path of ['/api/health','/api/config']) {
      assert.equal((await fetch(origin+path)).status,200);
      assert.equal((await fetch(origin+path,{method:'HEAD'})).status,200);
    }
    assert.equal(calls,0);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Maintenance blocks all operational requests before database, identity and payment access', async () => {
  const calls: string[] = [];
  const accounts = new Proxy({} as AccountService, {
    get: (_target, key) => {
      calls.push(String(key));
      return () => {
        throw Error('Must not access database');
      };
    },
  });
  const identity = new Proxy({} as IdentityProvider, {
    get: (_target, key) => {
      calls.push(String(key));
      return () => {
        throw Error('Must not access identity');
      };
    },
  });
  const server = createApp(
    { ...testConfig(), PLATFORM_MAINTENANCE: true },
    accounts,
    identity,
    undefined,
    { onboarding: {} as OnboardingService },
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  calls.length = 0;
  try {
    for (const path of [
      '/internal/bot/heartbeat',
      '/internal/bot/updates',
      '/api/me',
      '/api/checkout/plans',
      '/api/payments/purin/webhook',
      '/payments/purincash/generation',
      '/payments/subscriptions/generation',
      '/payments/mercadopago',
    ]) {
      const r = await fetch(origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).code, 'PLATFORM_MAINTENANCE');
      assert.equal(r.headers.get('Retry-After'), '600');
    }
    for (const path of ['/api/health', '/api/config'])
      assert.equal((await fetch(origin + path)).status, 200);
    assert.deepEqual(calls, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
