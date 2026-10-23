import type { Server } from 'node:http';
import { embeddedDatabase, migrate } from '../scripts/database-tools.js';
import { Accounts } from '../server/accounts.js';
import { createApp } from '../server/app.js';
import { loadConfig, type Config } from '../server/config.js';
import type { Identity, IdentityProvider } from '../server/types.js';
import type { BotVerifier } from '../server/bot-onboarding.js';
export const testConfig = () =>
  loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://127.0.0.1:3000',
    FIREBASE_PROJECT_ID: 'demo-blackout-create',
    FIREBASE_WEB_API_KEY: 'demo-key',
    FIREBASE_AUTH_DOMAIN: 'demo-blackout-create.firebaseapp.com',
  });
export async function fixture(
  provider?: IdentityProvider,
  configuration?: Config,
  verifyBot?: BotVerifier,
) {
  const db = embeddedDatabase();
  await migrate(db);
  const accounts = new Accounts(db),
    config = configuration ?? testConfig();
  const identity = (uid: string): Identity => ({
    uid,
    email: uid + '@example.com',
    emailVerified: uid !== 'unverified',
    authTime: Math.floor(Date.now() / 1000) - (uid === 'stale' ? 600 : 0),
  });
  const fake: IdentityProvider = {
    async verifyIdToken(token) {
      if (!token.startsWith('test-token:')) throw Error('invalid');
      return identity(token.slice(11));
    },
    async createSession(token) {
      return 'test-session:' + token.slice(11);
    },
    async verifySession(cookie) {
      if (!cookie.startsWith('test-session:')) throw Error('invalid');
      return identity(cookie.slice(13));
    },
  };
  const server = await new Promise<Server>((resolve) => {
    const s = createApp(config, accounts, provider || fake, verifyBot).listen(0, '127.0.0.1', () =>
      resolve(s),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('server address');
  const origin = 'http://127.0.0.1:' + address.port;
  async function agent() {
    const cookies = new Map<string, string>();
    let csrf = '';
    async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
      if (body !== undefined && (!csrf || !cookies.has('blackout_csrf'))) {
        const r = await request('/security/csrf');
        csrf = (await r.json()).token;
      }
      const r = await fetch(origin + '/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '),
          ...(body !== undefined
            ? {
                'Content-Type': 'application/json',
                Origin: config.APP_ORIGIN,
                'X-CSRF-Token': csrf,
              }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const cookie of r.headers.getSetCookie()) {
        const [key, value] = cookie.split(';')[0].split('=');
        if (value) cookies.set(key, value);
        else cookies.delete(key);
      }
      return r;
    }
    return {
      request,
      cookies,
      async login(uid: string) {
        const r = await request('/auth/session', { idToken: 'test-token:' + uid });
        if (!r.ok) throw Error('login ' + r.status);
        return r;
      },
    };
  }
  return {
    db,
    accounts,
    config,
    origin,
    agent,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.close();
    },
  };
}
