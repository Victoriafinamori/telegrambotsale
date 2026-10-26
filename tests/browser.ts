import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const origin = 'http://127.0.0.1:3000';
const config = await fetch(origin + '/api/config').then((r) => r.json());
assert.equal(config.emulatorHost, '127.0.0.1:9099');
assert.equal(
  config.firebase.projectId,
  'demo-blackout-create',
  'O teste de navegador não pode usar um projeto real.',
);
const provider = getAuth(initializeApp({ projectId: 'demo-blackout-create' }, 'browser-tests'));
const email = 'navegador-' + Date.now() + '@example.test',
  password = 'LocalBrowserOnly!42';
let uid: string | undefined;
const path =
  process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({
  executablePath: path,
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    merchantContext = await browser.newContext({ viewport: { width: 390, height: 844 } }),
    admin = await adminContext.newPage(),
    merchant = await merchantContext.newPage(),
    errors: string[] = [];
  for (const page of [admin, merchant]) page.on('pageerror', (e) => errors.push(e.message));
  await mkdir('.local/screenshots', { recursive: true });
  // The public landing remains usable while the private API is unavailable.
  await admin.route('**/api/**', (route) => route.abort());
  await admin.goto(origin);
  await admin.getByRole('heading', { name: /Sua loja no Telegram/ }).waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await admin.setViewportSize({ width, height: 1000 });
    assert(
      await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Landing: overflow em ' + width,
    );
    if (width === 390 || width === 1440)
      await admin.screenshot({
        path: '.local/screenshots/landing-' + (width === 390 ? 'mobile' : 'desktop') + '.png',
        fullPage: true,
      });
  }
  await admin.getByText('Onde vou configurar minha loja?', { exact: true }).click();
  assert(
    await admin
      .locator('details')
      .first()
      .evaluate((d) => d instanceof HTMLDetailsElement && d.open),
  );
  await admin.locator('#landing-login').click();
  await admin.getByRole('heading', { name: 'Acesso temporariamente indisponível' }).waitFor();
  await admin.unroute('**/api/**');
  await admin.locator('#retry-services').click();
  await admin.locator('#email').fill('admin@blackout.test');
  await admin.locator('#password').fill('BlackoutLocal!2026');
  await admin.locator('#auth-form button').click();
  await admin.getByRole('heading', { name: 'Lojistas', exact: true }).waitFor();
  await admin.locator('#new-account').click();
  await admin.locator('[name=name]').fill('Teste do navegador');
  await admin.locator('[name=storeName]').fill('Loja do navegador');
  await admin.locator('[name=email]').fill(email);
  await admin.locator('[name=channel]').selectOption('discord');
  await admin.locator('[name=price]').fill('49.90');
  await admin.locator('[name=reference]').fill('<script>alert("teste")</script>');
  await admin.locator('#registration-form button').click();
  await admin.locator('#confirm-purchase').waitFor();
  assert(
    (await admin.locator('.detail').textContent())?.includes('<script>alert("teste")</script>'),
  );
  assert.equal(await admin.locator('.detail script').count(), 0);
  await admin.locator('#confirm-purchase').click();
  await admin.locator('#issue-invite').click();
  await admin.locator('#invite-link').waitFor();
  const invite = await admin.locator('#invite-link').inputValue();
  await merchant.goto(invite);
  await merchant.locator('[data-auth-mode=signup]').click();
  await merchant.locator('#email').fill(email);
  await merchant.locator('#password').fill(password);
  await merchant.locator('#auth-form button').click();
  await merchant.getByRole('heading', { name: 'Confirme seu e-mail' }).waitFor();
  uid = (await provider.getUserByEmail(email)).uid;
  const messages = await fetch(
    'http://127.0.0.1:9099/emulator/v1/projects/demo-blackout-create/oobCodes',
  ).then((r) => r.json());
  const code = messages.oobCodes.find(
    (v: { email: string; requestType: string }) =>
      v.email === email && v.requestType === 'VERIFY_EMAIL',
  ).oobCode;
  const verified = await fetch(
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:update?key=demo-key',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: code }),
    },
  );
  assert.equal(verified.status, 200);
  await merchant.locator('#verified').click();
  await merchant.locator('#accept-invite').waitFor();
  await merchant.locator('#accept-invite').click();
  await merchant.getByRole('heading', { name: 'Sua loja está em análise' }).waitFor();
  assert(!merchant.url().includes('token='));
  assert.equal(await merchant.evaluate(() => localStorage.length), 0);
  await admin.reload();
  await admin.locator('[data-account]').filter({ hasText: email }).click();
  await admin.locator('#approve').click();
  await merchant.locator('#refresh').click();
  await merchant.getByRole('heading', { name: 'Crie seu bot no Telegram' }).waitFor();
  assert((await merchant.locator('.merchant-shell').textContent())?.includes('Ainda não iniciou'));
  // First access walks through creation, protected credentials, review and submission.
  await merchant.locator('#guide-next').click();
  await merchant.getByRole('heading', { name: 'Conecte seu bot' }).waitFor();
  await merchant.locator('#fill-demo-bot').click();
  const demoToken = String(Date.now()) + ':' + 'A'.repeat(35);
  await merchant.locator('#bot-token').fill(demoToken);
  assert.equal(await merchant.locator('#bot-token').getAttribute('type'), 'password');
  await merchant.locator('#toggle-bot-token').click();
  assert.equal(await merchant.locator('#bot-token').getAttribute('type'), 'text');
  await merchant.locator('#bot-setup-form button[type=submit]').click();
  await merchant.getByRole('heading', { name: 'Confira antes de enviar' }).waitFor();
  assert(!(await merchant.locator('body').textContent())?.includes(demoToken));
  await merchant.reload();
  await merchant.getByRole('heading', { name: 'Confira antes de enviar' }).waitFor();
  await merchant.locator('#submit-bot-setup').click();
  await merchant.getByRole('heading', { name: 'Dados recebidos pela Blackout Create' }).waitFor();
  await merchant.reload();
  await merchant.getByRole('heading', { name: 'Dados recebidos pela Blackout Create' }).waitFor();
  assert.equal(await merchant.evaluate(() => localStorage.length), 0);
  await admin.reload();
  await admin.locator('[data-account]').filter({ hasText: email }).click();
  await admin.locator('#request-bot-token').click();
  await admin.locator('#reveal-bot-token').click();
  await admin.locator('#activation-token').waitFor();
  assert.equal(await admin.locator('#activation-token').inputValue(), demoToken);
  await admin.locator('#close-dialog').click();
  assert.equal(await admin.locator('#activation-token').count(), 0);
  await admin.locator('[data-section=activations]').click();
  await admin.locator('[data-account]').filter({ hasText: email }).click();
  await admin.locator('#request-bot-changes').click();
  await admin.locator('[name=note]').fill('Confira seu ID pessoal. <b>Mensagem de teste</b>');
  await admin.locator('#bot-changes-form button[type=submit]').click();
  await admin
    .getByText('Correção solicitada. O cliente verá o motivo no assistente.', { exact: true })
    .waitFor();
  await merchant.locator('#refresh').click();
  await merchant.getByRole('heading', { name: 'Conecte seu bot' }).waitFor();
  assert(
    (await merchant.locator('.warning').first().textContent())?.includes(
      '<b>Mensagem de teste</b>',
    ),
  );
  assert.equal(await merchant.locator('.warning b').count(), 1);
  await merchant.locator('#bot-token').fill(demoToken);
  await merchant.locator('#bot-setup-form button[type=submit]').click();
  await merchant.locator('#submit-bot-setup').click();
  await merchant.getByRole('heading', { name: 'Dados recebidos pela Blackout Create' }).waitFor();
  await admin.reload();
  await admin.locator('[data-section=activations]').click();
  await admin.locator('[data-account]').filter({ hasText: email }).click();
  await admin.locator('#start-bot-configuration').click();
  await admin.locator('#confirm-bot-activation').waitFor();
  await merchant.locator('#refresh').click();
  await merchant.getByRole('heading', { name: 'Seu bot está em configuração' }).waitFor();
  await mkdir('.local/screenshots', { recursive: true });
  await admin.screenshot({ path: '.local/screenshots/admin-desktop.png', fullPage: true });
  await merchant.screenshot({ path: '.local/screenshots/merchant-mobile.png', fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await admin.setViewportSize({ width, height: 900 });
    await merchant.setViewportSize({ width, height: 900 });
    for (const page of [admin, merchant])
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Overflow em ' + width,
      );
    await admin.locator('#new-account').click();
    assert(await admin.locator('dialog').evaluate((d) => d.scrollWidth <= d.clientWidth));
    await admin.locator('#close-dialog').click();
    await admin.locator('#confirm-bot-activation').click();
    assert(await admin.locator('dialog').evaluate((d) => d.scrollWidth <= d.clientWidth));
    await admin.locator('#close-dialog').click();
  }
  await admin.locator('#suspend').click();
  await admin.locator('[name=reason]').fill('Revisão pelo administrador');
  await admin.locator('#suspend-form button').click();
  await admin.getByText('Acesso suspenso.', { exact: true }).waitFor();
  await merchant.locator('#refresh').click();
  await merchant.getByRole('heading', { name: 'Acesso suspenso', exact: true }).waitFor();
  await admin.locator('[data-section=accounts]').click();
  await admin.locator('[data-account]').filter({ hasText: email }).click();
  await admin.locator('#restore').click();
  await admin.getByText('Suspensão removida.', { exact: true }).waitFor();
  await merchant.locator('#refresh').click();
  await merchant.getByRole('heading', { name: 'Seu bot está em configuração' }).waitFor();
  await admin.locator('#confirm-bot-activation').click();
  const deploymentReference = 'square-browser-' + Date.now();
  await admin.locator('[name=deploymentReference]').fill(deploymentReference);
  await admin.locator('[name=ownerIdConfirmed]').check();
  await admin.locator('[name=botTested]').check();
  await admin.locator('#bot-activation-form button[type=submit]').click();
  await admin
    .getByText('Ativação confirmada. O período mensal começou agora.', { exact: true })
    .waitFor();
  await merchant.locator('#refresh').click();
  await merchant.getByRole('heading', { name: 'Seu bot foi ativado' }).waitFor();
  assert(!(await merchant.locator('.merchant-shell').textContent())?.includes('Ainda não iniciou'));
  await merchant.reload();
  await merchant.getByRole('heading', { name: 'Seu bot foi ativado' }).waitFor();
  await admin.locator('[data-section=accounts]').click();
  await admin.locator('[data-account]').filter({ hasText: email }).click();
  assert((await admin.locator('.detail').textContent())?.includes(deploymentReference));
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await merchant.setViewportSize({ width: 390, height: 844 });
  await admin.screenshot({ path: '.local/screenshots/admin-activation.png', fullPage: true });
  await merchant.screenshot({ path: '.local/screenshots/merchant-active.png', fullPage: true });
  await merchant.locator('#logout').click();
  await merchant.locator('#auth-form').waitFor();
  assert.equal(
    (await merchantContext.cookies()).filter((c) => c.name === 'blackout_session').length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASSOU: autenticação, convite, aprovação, assistente, correção, configuração, ativação manual, ciclo mensal, suspensão de acesso, logout, escape de HTML, ausência de tokens em localStorage e layouts 320–1440px.',
  );
} finally {
  await browser.close();
  if (uid) await provider.deleteUser(uid);
}
