import { z } from 'zod';
import webProject from '../config/firebase.web.json' with { type: 'json' };
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  API_PUBLIC_ORIGIN: z.url().optional(),
  FIREBASE_PROJECT_ID: z.string().min(3),
  FIREBASE_WEB_API_KEY: z.string().min(1),
  FIREBASE_AUTH_DOMAIN: z.string().min(1),
  FIREBASE_APP_ID: z.string().min(1).optional(),
  PLATFORM_DATABASE: z.enum(['postgres', 'firestore']).default('postgres'),
  API_AUTH_MODE: z.enum(['cookie', 'bearer']).default('cookie'),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  ADMIN_MFA_REQUIRED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ADMIN_MFA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  FIREBASE_HOSTING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SESSION_COOKIE_SIGNING_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  BOT_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.enum(['true', 'false']).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
});
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const useRegisteredProject =
    (env.FIREBASE_PROJECT_ID ?? webProject.projectId) === webProject.projectId;
  const v = schema.parse({
      ...env,
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID ?? webProject.projectId,
      FIREBASE_WEB_API_KEY:
        env.FIREBASE_WEB_API_KEY ?? (useRegisteredProject ? webProject.apiKey : undefined),
      FIREBASE_AUTH_DOMAIN:
        env.FIREBASE_AUTH_DOMAIN ?? (useRegisteredProject ? webProject.authDomain : undefined),
      FIREBASE_APP_ID: env.FIREBASE_APP_ID ?? (useRegisteredProject ? webProject.appId : undefined),
    }),
    origin = new URL(v.APP_ORIGIN);
  if (origin.origin !== v.APP_ORIGIN)
    throw new Error('APP_ORIGIN deve conter apenas a origem, sem caminho ou barra final.');
  if (v.DATABASE_URL) {
    const database = new URL(v.DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      [...database.searchParams.keys()].some((k) => k.startsWith('ssl'))
    )
      throw new Error(
        'Use uma URL PostgreSQL sem opções ssl; configure DATABASE_SSL separadamente.',
      );
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (v.API_PUBLIC_ORIGIN) {
    const apiOrigin = new URL(v.API_PUBLIC_ORIGIN);
    if (
      apiOrigin.origin !== v.API_PUBLIC_ORIGIN ||
      apiOrigin.username ||
      apiOrigin.password ||
      (v.NODE_ENV === 'production' && apiOrigin.protocol !== 'https:')
    )
      throw Error('API_PUBLIC_ORIGIN deve ser uma origem HTTPS exata em produção.');
  }
  if (v.NODE_ENV === 'production' && v.FIREBASE_HOSTING && !v.SESSION_COOKIE_SIGNING_KEY)
    throw new Error(
      'Firebase Hosting em produção exige SESSION_COOKIE_SIGNING_KEY no gerenciador de segredos.',
    );
  if (
    v.NODE_ENV === 'production' &&
    (origin.protocol !== 'https:' ||
      v.FIREBASE_AUTH_EMULATOR_HOST ||
      v.FIREBASE_PROJECT_ID.startsWith('demo-') ||
      v.FIRESTORE_EMULATOR_HOST ||
      (v.PLATFORM_DATABASE === 'postgres' && (!v.DATABASE_URL || v.DATABASE_SSL !== 'true')))
  )
    throw new Error('Produção exige HTTPS, PostgreSQL com TLS e Firebase real, sem emuladores.');
  if (
    v.FIREBASE_AUTH_EMULATOR_HOST &&
    (!loopback ||
      !/^127\.0\.0\.1:\d+$/.test(v.FIREBASE_AUTH_EMULATOR_HOST) ||
      !v.FIREBASE_PROJECT_ID.startsWith('demo-'))
  )
    throw new Error('O emulador exige loopback e um projeto demo- separado do projeto real.');
  if (
    v.FIRESTORE_EMULATOR_HOST &&
    (!loopback ||
      !/^127\.0\.0\.1:\d+$/.test(v.FIRESTORE_EMULATOR_HOST) ||
      !v.FIREBASE_PROJECT_ID.startsWith('demo-'))
  )
    throw new Error('Firestore emulado exige loopback e projeto demo-.');
  return {
    ...v,
    secure: v.NODE_ENV === 'production',
    sessionMs: 8 * 60 * 60 * 1000,
    inviteMs: 7 * 24 * 60 * 60 * 1000,
  };
}

export function publicFirebaseOptions(config: Config) {
  return {
    apiKey: config.FIREBASE_WEB_API_KEY,
    authDomain: config.FIREBASE_AUTH_DOMAIN,
    projectId: config.FIREBASE_PROJECT_ID,
    ...(config.FIREBASE_APP_ID ? { appId: config.FIREBASE_APP_ID } : {}),
  };
}
