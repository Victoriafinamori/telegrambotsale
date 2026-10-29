import 'dotenv/config';
import { loadConfig } from './config.js';
import { postgres } from './database.js';
import { firebaseIdentity } from './firebase.js';
import { Accounts } from './accounts.js';
import { createApp } from './app.js';
import { firebaseApp } from './firebase.js';
import { getFirestore } from 'firebase-admin/firestore';
import { FirestoreDocumentStore } from './document-store.js';
import { FirestorePlatform } from './firestore-platform.js';
import { AdminMfa } from './admin-mfa.js';
import { BotStore } from './bot-store.js';
import { AutomaticActivation } from './automatic-activation.js';
const config = loadConfig();
if (config.PLATFORM_DATABASE === 'postgres' && !config.DATABASE_URL)
  throw new Error('Configure DATABASE_URL ou use npm run local para o ambiente de testes.');
const db =
  config.PLATFORM_DATABASE === 'postgres'
    ? postgres(config.DATABASE_URL!, config.DATABASE_SSL === 'true')
    : null;
const firestore =
  config.PLATFORM_DATABASE === 'firestore'
    ? new FirestorePlatform(
        new FirestoreDocumentStore(getFirestore(firebaseApp(config))),
        config.BOT_TOKEN_ENCRYPTION_KEY,
        undefined,
        config.inviteMs,
      )
    : null;
const bots =
  firestore && config.BOT_TOKEN_ENCRYPTION_KEY
    ? new BotStore(firestore.store, config.BOT_TOKEN_ENCRYPTION_KEY)
    : undefined;
const activation =
  firestore && bots && config.BOT_TOKEN_ENCRYPTION_KEY && config.API_PUBLIC_ORIGIN
    ? new AutomaticActivation(
        bots,
        firestore.onboarding,
        config.BOT_TOKEN_ENCRYPTION_KEY,
        config.API_PUBLIC_ORIGIN,
      )
    : undefined;
const accounts = firestore ?? new Accounts(db!, config.inviteMs),
  app = createApp(
    config,
    accounts,
    firebaseIdentity(config),
    undefined,
    firestore
      ? {
          onboarding: firestore.onboarding,
          bots,
          activation,
          adminMfa: config.ADMIN_MFA_ENCRYPTION_KEY
            ? new AdminMfa(firestore.store, config.ADMIN_MFA_ENCRYPTION_KEY)
            : undefined,
        }
      : undefined,
  );
const server = app.listen(config.PORT, config.HOST, () =>
  console.log(`Blackout Create iniciada na porta ${config.PORT}.`),
);
const cleanup = setInterval(
  () =>
    void db
      ?.query('DELETE FROM api_rate_limits WHERE expires_at<now()')
      .catch(() => console.error('rate_cleanup.failed')),
  3600000,
);
cleanup.unref();
let resaleBusy = false;
let resaleCursor = '';
const resaleTick = setInterval(() => {
  if (!firestore || resaleBusy || !app.locals.subscriptions || !app.locals.purin) return;
  resaleBusy = true;
  void (async () => {
    const jobs = await firestore.store.list('resale_reconciliation', {
      limit: 5,
      equals: ['done', false],
      afterId: resaleCursor,
    });
    resaleCursor = jobs.length === 5 ? jobs.at(-1)!.id : '';
    for (const job of jobs)
      try {
        const done =
          job.kind === 'subscription'
            ? await app.locals.subscriptions.reconcileResale(job.invoiceId)
            : await app.locals.purin.reconcileResale(job.accountId, job.orderId);
        if (done)
          await firestore.store.transaction(async (tx) => {
            const current = await tx.get('resale_reconciliation/' + job.id);
            if (current) tx.set('resale_reconciliation/' + job.id, { ...current, done: true });
          });
      } catch {
        console.error('resale.reconciliation_retry');
      }
  })()
    .catch(() => console.error('resale.reconciliation_retry'))
    .finally(() => (resaleBusy = false));
}, 60000);
resaleTick.unref();
let activationBusy = false;
const activationTick = setInterval(() => {
  if (!activation || activationBusy) return;
  activationBusy = true;
  void activation
    .tick()
    .catch(() => console.error('activation.worker_retry'))
    .finally(() => {
      activationBusy = false;
    });
}, 15000);
activationTick.unref();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    clearInterval(cleanup);
    clearInterval(resaleTick);
    clearInterval(activationTick);
    server.close(() => void db?.close());
  });
