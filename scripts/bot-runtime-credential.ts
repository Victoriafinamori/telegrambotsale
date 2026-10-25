import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { loadConfig } from '../server/config.js';
import { firebaseApp } from '../server/firebase.js';
import { FirestoreDocumentStore } from '../server/document-store.js';
import { BotStore } from '../server/bot-store.js';

const value = (name: string) => {
  const pos = process.argv.indexOf(name);
  return pos < 0 ? undefined : process.argv[pos + 1];
};
const account = z.uuid().parse(value('--account')),
  appId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{6,120}$/)
    .parse(value('--app'));
const config = loadConfig();
if (config.PLATFORM_DATABASE !== 'firestore' || !config.BOT_TOKEN_ENCRYPTION_KEY)
  throw Error('Use the private Firestore server configuration');
const db = getFirestore(firebaseApp(config)),
  bots = new BotStore(new FirestoreDocumentStore(db), config.BOT_TOKEN_ENCRYPTION_KEY);
try {
  if (process.argv.includes('--revoke')) {
    await bots.revoke(account);
    console.log('Runtime credential revoked.');
  } else {
    const key = await bots.provision(account, appId);
    const folder = resolve('.local/bot-runtimes');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const destination = resolve(folder, `${account}-${randomUUID()}.env`);
    await writeFile(
      destination,
      `NODE_ENV=production\nPORT=80\nBOT_API_ORIGIN=${config.APP_ORIGIN === 'https://blackout-create.web.app' ? 'https://blackout-create-api.squareweb.app' : z.url().parse(value('--api-origin'))}\nBOT_RUNTIME_KEY=${key}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      'Runtime credential saved under .local/bot-runtimes. Install only in the matching private Square Cloud application environment.',
    );
  }
} finally {
  await db.terminate();
}
