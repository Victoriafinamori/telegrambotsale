import 'dotenv/config';
import { loadConfig } from './config.js';
import { postgres } from './database.js';
import { firebaseIdentity } from './firebase.js';
import { Accounts } from './accounts.js';
import { createApp } from './app.js';
const config = loadConfig();
if (!config.DATABASE_URL)
  throw new Error('Configure DATABASE_URL ou use npm run local para o ambiente de testes.');
const db = postgres(config.DATABASE_URL, config.DATABASE_SSL === 'true'),
  accounts = new Accounts(db, config.inviteMs),
  app = createApp(config, accounts, firebaseIdentity(config));
const server = app.listen(config.PORT, config.HOST, () =>
  console.log(`Blackout Create iniciada na porta ${config.PORT}.`),
);
const cleanup = setInterval(
  () =>
    void db
      .query('DELETE FROM api_rate_limits WHERE expires_at<now()')
      .catch(() => console.error('rate_cleanup.failed')),
  3600000,
);
cleanup.unref();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    clearInterval(cleanup);
    server.close(() => void db.close());
  });
