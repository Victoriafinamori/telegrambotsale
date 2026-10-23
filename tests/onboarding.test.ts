import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, testConfig } from './helpers.js';
import { BotOnboarding, verifyDemoBot, verifyTelegramBot } from '../server/bot-onboarding.js';
import type { MerchantAccount } from '../server/types.js';

const token = '123456789:' + 'B'.repeat(35);
const input = { botToken: token, telegramUserId: '987654321' };
const verifier = async () => ({ id: '123456789', username: 'TestStoreBot' });
async function approved(
  f: Awaited<ReturnType<typeof fixture>>,
  uid: string,
): Promise<MerchantAccount> {
  const a = await f.accounts.register(
    {
      name: 'Teste',
      email: uid + '@example.com',
      storeName: 'Loja',
      channel: 'telegram',
      reference: '',
      priceCents: 4990,
    },
    'admin',
  );
  await f.accounts.confirm(a.id, 'admin');
  const invitation = await f.accounts.invite(a.id, 'admin');
  await f.accounts.accept(invitation.token, {
    uid,
    email: uid + '@example.com',
    emailVerified: true,
    authTime: Date.now() / 1000,
  });
  return f.accounts.approve(a.id, 'admin');
}

test('Onboarding: token cifrado, revisão persistida, consulta administrativa auditada e nenhuma cobrança antecipada', async () => {
  const config = {
    ...testConfig(),
    BOT_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  };
  const f = await fixture(undefined, config, verifier);
  try {
    await f.db.query('INSERT INTO platform_admins(firebase_uid) VALUES($1)', ['admin']);
    const a = await approved(f, 'merchant');
    const merchant = await f.agent(),
      admin = await f.agent(),
      other = await f.agent(),
      anon = await f.agent();
    await merchant.login('merchant');
    await admin.login('admin');
    await other.login('other');
    assert.equal((await anon.request('/onboarding')).status, 401);
    assert.equal((await other.request('/onboarding', input)).status, 403);
    assert.equal((await merchant.request('/onboarding/submit', {})).status, 409);
    assert.equal(
      (await merchant.request('/onboarding', { ...input, accountId: a.id })).status,
      400,
    );
    assert.equal(
      (await merchant.request('/onboarding', { ...input, telegramUserId: '-100123' })).status,
      400,
    );
    assert.equal(
      (await merchant.request('/onboarding', { ...input, telegramUserId: 'abc' })).status,
      400,
    );
    assert.equal(
      (await merchant.request('/onboarding', { ...input, telegramUserId: '9999999999999999' }))
        .status,
      400,
    );
    const saved = await merchant.request('/onboarding', input);
    assert.equal(saved.status, 200);
    const setup = (await saved.json()).setup;
    assert.equal(setup.bot_username, 'TestStoreBot');
    assert.equal(setup.telegram_user_id, input.telegramUserId);
    assert.equal(setup.submitted_at, null);
    assert(!JSON.stringify(setup).includes(token));
    assert(!('token_ciphertext' in setup));
    const raw = (
      await f.db.query<{ token_ciphertext: string }>(
        'SELECT token_ciphertext FROM merchant_bot_setup WHERE account_id=$1',
        [a.id],
      )
    ).rows[0].token_ciphertext;
    assert(raw.startsWith('v1.'));
    assert(!raw.includes(token));
    assert.equal((await admin.request('/admin/accounts/' + a.id + '/bot-token', {})).status, 409);
    assert.equal((await merchant.request('/onboarding/submit', {})).status, 200);
    assert.equal((await merchant.request('/onboarding/submit', {})).status, 200);
    const fresh = await f.agent();
    await fresh.login('merchant');
    assert((await (await fresh.request('/onboarding')).json()).setup.submitted_at);
    assert.equal(
      (await merchant.request('/admin/accounts/' + a.id + '/bot-token', {})).status,
      403,
    );
    const publicData = await admin.request('/admin/accounts/' + a.id + '/bot-setup');
    assert(!(await publicData.text()).includes(token));
    const reveal = await admin.request('/admin/accounts/' + a.id + '/bot-token', {});
    assert.equal(reveal.status, 200);
    assert.equal(reveal.headers.get('cache-control'), 'no-store');
    assert.equal((await reveal.json()).token, token);
    const history = await f.accounts.history();
    assert.equal(history.filter((e) => e.action === 'bot_setup.submitted').length, 1);
    assert.equal(history.filter((e) => e.action === 'bot_token.accessed').length, 1);
    assert(!JSON.stringify(history).includes(token));
    const account = await f.accounts.own('merchant');
    assert.equal(account?.billing_started_at, null);
    assert.equal(account?.paid_through, null);
    // Authenticated encryption rejects a modified tenant-bound payload.
    await f.db.query(
      "UPDATE merchant_bot_setup SET token_ciphertext=token_ciphertext || 'x' WHERE account_id=$1",
      [a.id],
    );
    const rejected = await admin.request('/admin/accounts/' + a.id + '/bot-token', {});
    assert.equal(rejected.status, 503);
    assert(!(await rejected.text()).includes(token));
  } finally {
    await f.close();
  }
});

test('Onboarding: unicidade do bot, suspensão e falta da chave não permitem envio inseguro', async () => {
  const config = {
    ...testConfig(),
    BOT_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  };
  const f = await fixture(undefined, config, verifier);
  try {
    const a = await approved(f, 'merchant');
    await approved(f, 'other');
    const one = await f.agent(),
      two = await f.agent();
    await one.login('merchant');
    await two.login('other');
    assert.equal((await one.request('/onboarding', input)).status, 200);
    assert.equal((await two.request('/onboarding', input)).status, 409);
    assert.equal((await (await two.request('/onboarding')).json()).setup, null);
    const unavailable = new BotOnboarding(f.accounts, undefined, verifier);
    await assert.rejects(() => unavailable.save('other', input), { code: 'BOT_SETUP_UNAVAILABLE' });
    const wrongKey = new BotOnboarding(f.accounts, randomBytes(32).toString('base64url'), verifier);
    await one.request('/onboarding/submit', {});
    await assert.rejects(() => wrongKey.reveal(a.id, 'admin'), { code: 'BOT_SECRET_UNAVAILABLE' });
    await f.accounts.suspend(a.id, 'Revisão', 'admin');
    assert.equal((await one.request('/onboarding')).status, 403);
    assert.equal((await one.request('/onboarding', input)).status, 403);
    assert.equal((await one.request('/onboarding/submit', {})).status, 403);
    await f.accounts.restore(a.id, 'admin');
    // A live subscription must use a separate operational rotation flow.
    await f.db.query(
      'UPDATE merchant_accounts SET billing_started_at=now(),paid_through=now() WHERE id=$1',
      [a.id],
    );
    assert.equal((await one.request('/onboarding', input)).status, 409);
  } finally {
    await f.close();
  }
});

test('Validação Telegram não divulga URL/token em falhas e demo nunca aceita credenciais reais', async (t) => {
  const spy = t.mock.method(globalThis, 'fetch', async () => {
    throw Error('Network error with ' + token);
  });
  await assert.rejects(
    () => verifyTelegramBot(token),
    (error: unknown) => {
      assert(!String(error).includes(token));
      return true;
    },
  );
  spy.mock.mockImplementation(async () => new Response('{}', { status: 401 }));
  await assert.rejects(() => verifyTelegramBot(token), { code: 'BOT_TOKEN_INVALID' });
  spy.mock.mockImplementation(async () =>
    Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: 'StoreBot' } }),
  );
  assert.deepEqual(await verifyTelegramBot(token), { id: '123456789', username: 'StoreBot' });
  const count = spy.mock.callCount();
  await assert.rejects(() => verifyDemoBot(token), { code: 'DEMO_TOKEN_ONLY' });
  assert.equal((await verifyDemoBot('123456789:' + 'A'.repeat(35))).id, '123456789');
  assert.equal(spy.mock.callCount(), count);
});

test('Dono revisa, solicita correção e confirma ativação manual, com cobrança única e dados atualizados', async () => {
  const f = await fixture(
    undefined,
    { ...testConfig(), BOT_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64url') },
    verifier,
  );
  try {
    await f.db.query('INSERT INTO platform_admins(firebase_uid) VALUES($1)', ['admin']);
    const a = await approved(f, 'merchant');
    const admin = await f.agent(),
      merchant = await f.agent(),
      stranger = await f.agent();
    await admin.login('admin');
    await merchant.login('merchant');
    await stranger.login('stranger');
    const path = '/admin/accounts/' + a.id + '/bot-setup/';
    const base = {
      revision: 1,
      deploymentReference: 'square-client-app-001',
      botTested: true,
      ownerIdConfirmed: true,
    };
    assert.equal((await merchant.request(path + 'activate', base)).status, 403);
    assert.equal(
      (await stranger.request(path + 'review', { action: 'configure', revision: 1 })).status,
      403,
    );
    assert.equal((await admin.request(path + 'activate', base)).status, 409);
    await merchant.request('/onboarding', input);
    await merchant.request('/onboarding/submit', {});
    const read = async () => (await (await merchant.request('/onboarding')).json()).setup;
    let setup = await read();
    const queue = await (await admin.request('/admin/accounts?queue=activation')).json();
    assert.deepEqual(
      queue.accounts.map((v: { id: string }) => v.id),
      [a.id],
    );
    assert(!JSON.stringify(queue).includes(token));
    assert.equal(
      (await admin.request(path + 'activate', { ...base, revision: setup.revision })).status,
      409,
    );
    const review = await admin.request(path + 'review', {
      action: 'configure',
      revision: setup.revision,
    });
    assert.equal(review.status, 200);
    const configuring = (await review.json()).setup;
    assert.equal(configuring.activation_status, 'configuring');
    assert.equal((await merchant.request('/onboarding', input)).status, 409);
    assert.equal(
      (await admin.request(path + 'activate', { ...base, revision: setup.revision })).status,
      409,
    );
    assert.equal(
      (
        await admin.request(path + 'activate', {
          ...base,
          revision: configuring.revision,
          botTested: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await admin.request(path + 'activate', {
          ...base,
          revision: configuring.revision,
          ownerIdConfirmed: false,
        })
      ).status,
      400,
    );
    const corrections = await admin.request(path + 'review', {
      action: 'request_changes',
      revision: configuring.revision,
      note: 'Confira seu ID pessoal.',
    });
    assert.equal(corrections.status, 200);
    setup = await read();
    assert.equal(setup.review_note, 'Confira seu ID pessoal.');
    assert.equal(
      (await admin.request(path + 'review', { action: 'configure', revision: setup.revision }))
        .status,
      409,
    );
    assert.equal(
      (await (await admin.request('/admin/accounts?queue=activation')).json()).accounts.length,
      0,
    );
    await merchant.request('/onboarding', { ...input, telegramUserId: '987654322' });
    assert.equal((await read()).submitted_at, null);
    assert.equal(
      (
        await admin.request(path + 'review', {
          action: 'configure',
          revision: (await read()).revision,
        })
      ).status,
      409,
    );
    await merchant.request('/onboarding/submit', {});
    setup = await read();
    assert.equal(setup.review_note, null);
    await admin.request(path + 'review', { action: 'configure', revision: setup.revision });
    setup = await read();
    assert.equal((await f.accounts.own('merchant'))?.billing_started_at, null);
    const body = { ...base, revision: setup.revision };
    // Browser retries and simultaneous confirmations preserve one original period.
    const responses = await Promise.all([
      admin.request(path + 'activate', body),
      admin.request(path + 'activate', body),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 200],
    );
    const result = await responses[0].json(),
      duplicate = await responses[1].json();
    assert.equal(result.setup.activation_status, 'active');
    const store = await (await merchant.request('/store')).json();
    assert.equal(store.botStatus, 'activation_confirmed');
    assert.equal(store.runtimeStatus, 'unknown');
    assert.equal(result.setup.deployment_reference, body.deploymentReference);
    assert(result.account.billing_started_at);
    assert(result.account.paid_through);
    assert.equal(result.account.billing_started_at, duplicate.account.billing_started_at);
    assert.equal(result.account.paid_through, duplicate.account.paid_through);
    const duration =
      new Date(result.account.paid_through).getTime() -
      new Date(result.account.billing_started_at).getTime();
    assert(duration >= 28 * 86400000 && duration <= 31 * 86400000);
    assert.equal(
      (await (await admin.request('/admin/accounts?queue=activation')).json()).accounts.length,
      0,
    );
    const all = await (await admin.request('/admin/accounts')).json();
    assert.equal(all.accounts[0].bot_activation_status, 'active');
    assert.equal(
      (await f.accounts.history()).filter((e) => e.action === 'bot_activation.confirmed_manually')
        .length,
      1,
    );
    assert.equal((await merchant.request('/onboarding', input)).status, 409);
    await f.db.query('DELETE FROM platform_admins WHERE firebase_uid=$1', ['admin']);
    assert.equal((await admin.request(path + 'activate', body)).status, 403);
  } finally {
    await f.close();
  }
});

test('Um aplicativo por cliente: conflito e suspensão não iniciam nem alteram mensalidade', async () => {
  const f = await fixture(
    undefined,
    { ...testConfig(), BOT_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64url') },
    async (v) => ({ id: v.split(':')[0], username: 'StoreBot' }),
  );
  try {
    await f.db.query('INSERT INTO platform_admins(firebase_uid) VALUES($1)', ['admin']);
    const admin = await f.agent();
    await admin.login('admin');
    for (const [index, uid] of ['one', 'two'].entries()) {
      const a = await approved(f, uid),
        user = await f.agent();
      await user.login(uid);
      await user.request('/onboarding', {
        ...input,
        botToken: String(123456789 + index) + ':' + 'B'.repeat(35),
      });
      await user.request('/onboarding/submit', {});
      let setup = (await (await user.request('/onboarding')).json()).setup;
      const path = '/admin/accounts/' + a.id + '/bot-setup/';
      await admin.request(path + 'review', { revision: setup.revision, action: 'configure' });
      setup = (await (await user.request('/onboarding')).json()).setup;
      const body = {
        revision: setup.revision,
        deploymentReference: 'square-same-app',
        botTested: true,
        ownerIdConfirmed: true,
      };
      assert.equal((await admin.request(path + 'activate', body)).status, index === 0 ? 200 : 409);
      if (index === 1) {
        assert.equal((await f.accounts.own(uid))?.billing_started_at, null);
        assert.equal((await f.accounts.own(uid))?.paid_through, null);
        await f.accounts.suspend(a.id, 'Conferir contratação', 'admin');
        assert.equal(
          (
            await admin.request(path + 'activate', {
              ...body,
              deploymentReference: 'square-other-app',
            })
          ).status,
          409,
        );
        assert.equal((await f.accounts.own(uid))?.billing_started_at, null);
      }
    }
  } finally {
    await f.close();
  }
});
