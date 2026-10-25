import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { getAuth } from 'firebase-admin/auth';
import { firebaseApp, firebaseIdentity } from '../server/firebase.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { AdminMfa, totp } from '../server/admin-mfa.js';
import { MemoryDocuments } from './document-memory.js';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const config = loadConfig({
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://127.0.0.1:3001',
  FIREBASE_PROJECT_ID: 'demo-blackout-create',
  FIREBASE_WEB_API_KEY: 'demo-key',
  FIREBASE_AUTH_DOMAIN: 'demo-blackout-create.firebaseapp.com',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  API_AUTH_MODE: 'bearer',
  ADMIN_MFA_REQUIRED: 'true',
});
const store = new MemoryDocuments(),
  platform = new FirestorePlatform(store),
  mfa = new AdminMfa(store, randomBytes(32).toString('base64url'));
const admin = await getAuth(firebaseApp(config)).getUserByEmail('admin@blackout.test');
await platform.grantAdmin(admin.uid);
const server = createApp(config, platform, firebaseIdentity(config), undefined, {
  onboarding: platform.onboarding,
  adminMfa: mfa,
}).listen(3001, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(config.APP_ORIGIN + '/#/entrar');
  await page.locator('#email').fill('admin@blackout.test');
  await page.locator('#password').fill('BlackoutLocal!2026');
  await page.locator('#auth-form button').click();
  await page.getByRole('heading', { name: 'Confirme seu acesso' }).waitFor();
  assert.equal(await page.locator('#new-account').count(), 0);
  await page.locator('#enroll-admin-mfa').click();
  await page.locator('#admin-mfa-qr').waitFor();
  await page.getByText('Não consigo escanear', { exact: true }).click();
  await page.locator('#mfa-secret').waitFor();
  const seed = await page.locator('#mfa-secret').inputValue();
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of seed) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  await page.locator('#mfa-code').fill(totp(Buffer.from(bytes), Math.floor(Date.now() / 30000)));
  const verified = page.waitForResponse(
    (r) => r.url().endsWith('/api/security/admin-mfa/verify') && r.status() === 200,
  );
  await page.locator('#mfa-form button').click();
  const proof = (await (await verified).json()).proof;
  await page.getByRole('heading', { name: 'Lojistas', exact: true }).waitFor();
  assert.equal(await page.locator('#mfa-secret').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes(proof));
  await page.reload();
  await page.getByRole('heading', { name: 'Confirme seu acesso' }).waitFor();
  assert.equal(await page.locator('#enroll-admin-mfa').count(), 0);
  assert.equal(await page.locator('#mfa-secret').count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/admin-mfa-challenge.png', fullPage: true });
  await page.locator('#logout').click();
  await page.locator('#auth-form').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASSOU: login Firebase emulado, matrícula TOTP, desbloqueio do painel, prova somente em memória, nova exigência após reload e logout. Banco de domínio de teste; nenhum Firebase real.',
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
