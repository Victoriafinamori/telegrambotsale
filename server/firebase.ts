import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { Config } from './config.js';
import type { Identity, IdentityProvider } from './types.js';
export function firebaseApp(config: Config) {
  return (
    getApps().find((a) => a.name === config.FIREBASE_PROJECT_ID) ||
    initializeApp(
      {
        projectId: config.FIREBASE_PROJECT_ID,
        ...(!config.FIREBASE_AUTH_EMULATOR_HOST ? { credential: applicationDefault() } : {}),
      },
      config.FIREBASE_PROJECT_ID,
    )
  );
}
export function firebaseIdentity(config: Config): IdentityProvider {
  const app = firebaseApp(config);
  const auth = getAuth(app),
    identity = (v: DecodedIdToken): Identity => ({
      uid: v.uid,
      email: v.email || '',
      emailVerified: v.email_verified === true,
      authTime: v.auth_time,
      secondFactor: Boolean(v.firebase?.sign_in_second_factor),
    });
  return {
    async verifyIdToken(token) {
      return identity(await auth.verifyIdToken(token, true));
    },
    async createSession(token, expiresIn) {
      return auth.createSessionCookie(token, { expiresIn });
    },
    async verifySession(cookie) {
      return identity(await auth.verifySessionCookie(cookie, true));
    },
  };
}
