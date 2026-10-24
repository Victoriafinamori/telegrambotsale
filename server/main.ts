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
const accounts = firestore ?? new Accounts(db!, config.inviteMs),
  app = createApp(
    config,
    accounts,
    firebaseIdentity(config),
    undefined,
    firestore
      ? {
          onboarding: firestore.onboarding,
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
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    clearInterval(cleanup);
    server.close(() => void db?.close());
  });
