// Isolated local environment: no Google credentials or real Firebase project required.
import { spawn } from 'node:child_process';
import { emulatorEnv } from './emulator-env.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { embeddedDatabase, migrate } from './database-tools.js';
import { firebaseIdentity } from '../server/firebase.js';
import { getAuth } from 'firebase-admin/auth';
import { getApp } from 'firebase-admin/app';
import { Accounts } from '../server/accounts.js';
import { createApp } from '../server/app.js';
process.env.NODE_ENV = 'development';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_PROJECT_ID = 'demo-blackout-create';
await mkdir('.local', { recursive: true });
const localKeyFile = '.local/bot-token.key';
if (!existsSync(localKeyFile))
  await writeFile(localKeyFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
const config = loadConfig({
  ...process.env,
  APP_ORIGIN: 'http://127.0.0.1:3000',
  PORT: '3000',
  FIREBASE_WEB_API_KEY: 'demo-key',
  FIREBASE_AUTH_DOMAIN: 'demo-blackout-create.firebaseapp.com',
  FIREBASE_APP_ID: undefined,
  FIREBASE_HOSTING: 'false',
  SESSION_COOKIE_SIGNING_KEY: undefined,
  BOT_TOKEN_ENCRYPTION_KEY: (await readFile(localKeyFile, 'utf8')).trim(),
});
// Ignore ambient Google credentials: this program can address the local emulator only.
await mkdir('.local', { recursive: true });
const emulatorArgs = [
  'emulators:start',
  '--only',
  'auth',
  '--project',
  config.FIREBASE_PROJECT_ID,
  ...(existsSync('.local/firebase/firebase-export-metadata.json')
    ? ['--import=.local/firebase']
    : []),
];
const child = spawn('./node_modules/.bin/firebase', emulatorArgs, {
  stdio: 'inherit',
  env: emulatorEnv(),
  detached: process.platform !== 'win32',
});
let stopping = false;
async function waitForEmulator() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('O emulador não iniciou.');
    try {
      const r = await fetch('http://127.0.0.1:9099/');
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Tempo limite aguardando o emulador.');
}
try {
  await waitForEmulator();
  await mkdir('.local', { recursive: true });
  const db = embeddedDatabase('.local/platform');
  await migrate(db);
  const provider = firebaseIdentity(config),
    auth = getAuth(getApp(config.FIREBASE_PROJECT_ID));
  for (const email of ['admin@blackout.test', 'lojista@blackout.test']) {
    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      user = await auth.createUser({ email, password: 'BlackoutLocal!2026', emailVerified: true });
    }
    if (email.startsWith('admin@'))
      await db.query(
        'INSERT INTO platform_admins(firebase_uid) VALUES($1) ON CONFLICT DO NOTHING',
        [user.uid],
      );
  }
  const server = createApp(config, new Accounts(db), provider).listen(3000, '127.0.0.1', () =>
    console.log(
      'Ambiente LOCAL em http://127.0.0.1:3000 — contas de teste na tela. Não use dados reais.',
    ),
  );
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const response = await fetch('http://127.0.0.1:4400/_admin/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: resolve('.local/firebase'),
            initiatedBy: 'exit',
            targets: ['auth'],
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw Error('export');
      }
    } catch {
      console.error('Não foi possível salvar os usuários locais do emulador.');
    } finally {
      child.kill('SIGINT');
      await db.close();
    }
  };
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => void stop());
  child.once('exit', () => {
    if (!stopping) void stop();
  });
  server.on('error', () => {
    console.error('Não foi possível abrir a porta local.');
    void stop();
    process.exitCode = 1;
  });
} catch (e) {
  child.kill('SIGINT');
  throw e;
}
