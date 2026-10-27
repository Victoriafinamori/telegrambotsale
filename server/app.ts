import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { publicFirebaseOptions, type Config } from './config.js';
import { Accounts, tokenHash } from './accounts.js';
import { enforceAdminSecondFactor } from './admin-policy.js';
import { SessionTransport } from './session-transport.js';
import {
  BotOnboarding,
  botCredentials,
  verifyDemoBot,
  type BotVerifier,
} from './bot-onboarding.js';
import { HttpError, type Identity, type IdentityProvider } from './types.js';
import type { AccountService, OnboardingService } from './platform-contract.js';
import type { AdminMfa } from './admin-mfa.js';
import type { BotStore } from './bot-store.js';
import { botRuntimeRouter } from './bot-runtime-routes.js';
import { MerchantConsole } from './merchant-console.js';
import { merchantConsoleRouter } from './merchant-console-routes.js';
import { MercadoPagoPayments } from './mercado-pago.js';
import { PurinCashPayments } from './purin-cash.js';
import { PaymentGateway } from './payment-gateway.js';
import { PurinWallet } from './purin-wallet.js';
import { PlatformSubscriptions } from './platform-subscriptions.js';
import type { AutomaticActivation } from './automatic-activation.js';
import { readSetupProgress } from './setup-progress.js';
import { StoreTest } from './store-test.js';
import { AdminHealth } from './admin-health.js';
import { publicPaymentRouter, mercadoPagoWebhook } from './payment-routes.js';
type AuthedRequest = Request & { identity: Identity; requestId: string };
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  idSchema = z.uuid();
const registration = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.email().trim().toLowerCase().max(254),
    storeName: z.string().trim().min(1).max(80),
    channel: z.enum(['whatsapp', 'telegram', 'discord', 'site', 'other']),
    reference: z.string().trim().max(200).default(''),
    priceCents: z.number().int().min(1).max(10000000),
  })
  .strict();
export function createApp(
  config: Config,
  accounts: AccountService,
  auth: IdentityProvider,
  verifyBot?: BotVerifier,
  services?: {
    onboarding?: OnboardingService;
    adminMfa?: AdminMfa;
    bots?: BotStore;
    payments?: MercadoPagoPayments;
    purin?: PurinCashPayments;
    wallet?: PurinWallet;
    activation?: AutomaticActivation;
  },
) {
  const app = express(),
    sessions = new SessionTransport(config),
    onboarding =
      services?.onboarding ??
      (accounts instanceof Accounts
        ? new BotOnboarding(
            accounts,
            config.BOT_TOKEN_ENCRYPTION_KEY,
            verifyBot ?? (config.FIREBASE_AUTH_EMULATOR_HOST ? verifyDemoBot : undefined),
          )
        : null);
  if (!onboarding) throw new Error('Configure o serviço de onboarding para o banco selecionado.');
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use((req, res, next) => {
    (req as unknown as AuthedRequest).requestId = randomUUID();
    res.set('X-Request-ID', (req as unknown as AuthedRequest).requestId);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: [
            "'self'",
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            ...(config.FIREBASE_AUTH_EMULATOR_HOST
              ? ['http://' + config.FIREBASE_AUTH_EMULATOR_HOST]
              : []),
          ],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.secure ? [] : null,
        },
      },
      strictTransportSecurity: config.secure
        ? { maxAge: 15552000, includeSubDomains: false }
        : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin === config.APP_ORIGIN) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      if (config.API_AUTH_MODE === 'cookie') res.set('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    const requested = (req.get('access-control-request-headers') || '')
      .toLowerCase()
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      origin !== config.APP_ORIGIN ||
      !['GET', 'POST'].includes(req.get('access-control-request-method') || '') ||
      requested.some(
        (v) => !['content-type', 'authorization', 'x-csrf-token', 'x-admin-mfa'].includes(v),
      )
    ) {
      res.sendStatus(403);
      return;
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-CSRF-Token, X-Admin-MFA',
    );
    res.set('Access-Control-Max-Age', '600');
    res.sendStatus(204);
  });
  const rate =
    (scope: string, limit: number, ms: number) =>
    async (req: Request, _res: Response, next: NextFunction) => {
      try {
        await accounts.consumeRate(scope + ':' + tokenHash(req.ip || 'unknown'), limit, ms);
        next();
      } catch (e) {
        next(e);
      }
    };
  const payments =
    services?.payments ??
    (services?.bots && config.BOT_TOKEN_ENCRYPTION_KEY
      ? new MercadoPagoPayments(
          services.bots.store,
          config.BOT_TOKEN_ENCRYPTION_KEY,
          services.bots,
          config.APP_ORIGIN,
          config.API_PUBLIC_ORIGIN ?? config.APP_ORIGIN,
          fetch,
          undefined,
          !config.FIREBASE_PROJECT_ID.startsWith('demo-') &&
            !config.FIRESTORE_EMULATOR_HOST &&
            !config.FIREBASE_AUTH_EMULATOR_HOST,
        )
      : undefined);
  const purin =
    services?.purin ??
    (payments && services?.bots && config.BOT_TOKEN_ENCRYPTION_KEY
      ? new PurinCashPayments(
          services.bots.store,
          config.BOT_TOKEN_ENCRYPTION_KEY,
          services.bots,
          config.APP_ORIGIN,
          config.API_PUBLIC_ORIGIN ?? config.APP_ORIGIN,
          fetch,
          undefined,
          !config.FIREBASE_PROJECT_ID.startsWith('demo-') &&
            !config.FIRESTORE_EMULATOR_HOST &&
            !config.FIREBASE_AUTH_EMULATOR_HOST,
        )
      : undefined);
  const gateway = payments && purin ? new PaymentGateway(payments, purin) : payments;
  const wallet =
    services?.wallet ??
    (services?.bots && config.BOT_TOKEN_ENCRYPTION_KEY
      ? new PurinWallet(
          services.bots.store,
          config.BOT_TOKEN_ENCRYPTION_KEY,
          config.APP_ORIGIN,
          fetch,
          undefined,
          !config.FIREBASE_PROJECT_ID.startsWith('demo-') &&
            !config.FIRESTORE_EMULATOR_HOST &&
            !config.FIREBASE_AUTH_EMULATOR_HOST,
        )
      : undefined);
  if (services?.bots) services.bots.wallet = wallet;
  const subscriptions =
    purin && services?.bots && config.BOT_TOKEN_ENCRYPTION_KEY
      ? new PlatformSubscriptions(
          services.bots.store,
          config.BOT_TOKEN_ENCRYPTION_KEY,
          purin,
          config.APP_ORIGIN,
          config.API_PUBLIC_ORIGIN ?? config.APP_ORIGIN,
        )
      : undefined;
  if (services?.bots) app.use('/internal/bot', botRuntimeRouter(services.bots, accounts, gateway));
  app.use('/api', rate('api', 300, 60000));
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    if (req.headers.origin !== config.APP_ORIGIN) {
      next(new HttpError(403, 'ORIGIN_REJECTED', 'Origem da solicitação não permitida.'));
      return;
    }
    if (!req.is('application/json')) {
      next(new HttpError(415, 'JSON_REQUIRED', 'Use uma solicitação JSON.'));
      return;
    }
    next();
  });
  if (purin)
    app.post(
      '/payments/purincash/:generation',
      rate('purin-webhook', 300, 60000),
      express.raw({ type: 'application/json', limit: '16kb' }),
      async (req, res) => {
        if (!Buffer.isBuffer(req.body))
          throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Use JSON.');
        await purin.notify(
          String(req.params.generation),
          req.body,
          req.get('x-webhook-signature') ?? '',
          req.get('x-webhook-id') ?? '',
        );
        res.json({ ok: true });
      },
    );
  if (subscriptions)
    app.post(
      '/payments/subscriptions/:generation',
      rate('subscription-webhook', 300, 60000),
      express.raw({ type: 'application/json', limit: '16kb' }),
      async (req, res) => {
        if (!Buffer.isBuffer(req.body))
          throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Use JSON.');
        await subscriptions.notify(
          String(req.params.generation),
          req.body,
          req.get('x-webhook-signature') ?? '',
          req.get('x-webhook-id') ?? '',
        );
        res.json({ ok: true });
      },
    );
  app.use((req, res, next) =>
    express.json({
      limit:
        req.path === '/api/store/manage/media'
          ? '5mb'
          : req.path === '/api/store/manage/stock'
            ? '32kb'
            : '16kb',
      strict: true,
    })(req, res, next),
  );
  if (payments) {
    app.use('/payments/mercadopago', rate('mp-webhook', 1000, 60000), mercadoPagoWebhook(payments));
    app.use(
      '/api/payments/checkout',
      rate('pix-checkout', 30, 60000),
      publicPaymentRouter(gateway!),
    );
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) =>
    res.json({
      firebase: publicFirebaseOptions(config),
      emulatorHost: config.FIREBASE_AUTH_EMULATOR_HOST || null,
      authMode: config.API_AUTH_MODE,
    }),
  );
  app.get('/api/security/csrf', (req, res) => {
    const token = randomBytes(32).toString('base64url');
    sessions.setCsrf(req, res, token);
    res.json({ token });
  });
  app.use('/api', (req, _res, next) => {
    if (config.API_AUTH_MODE === 'bearer') {
      next();
      return;
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    const c = sessions.csrf(req),
      h = req.get('x-csrf-token') || '';
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(c) ||
      !/^[A-Za-z0-9_-]{43}$/.test(h) ||
      c.length !== h.length ||
      !timingSafeEqual(Buffer.from(c), Buffer.from(h))
    ) {
      next(new HttpError(403, 'CSRF_REJECTED', 'Recarregue a página e tente novamente.'));
      return;
    }
    next();
  });
  async function identity(req: Request, _res: Response, next: NextFunction) {
    try {
      const value = binding(req);
      if (!value) throw new Error('missing');
      const user =
        config.API_AUTH_MODE === 'bearer'
          ? await auth.verifyIdToken(value)
          : await auth.verifySession(value);
      if (!user.emailVerified || !user.email)
        throw new HttpError(403, 'EMAIL_UNVERIFIED', 'Confirme seu e-mail para continuar.');
      (req as unknown as AuthedRequest).identity = user;
      next();
    } catch (e) {
      next(
        e instanceof HttpError
          ? e
          : new HttpError(401, 'SESSION_INVALID', 'Entre novamente para continuar.'),
      );
    }
  }
  function binding(req: Request) {
    const header = req.get('authorization') || '';
    return config.API_AUTH_MODE === 'bearer'
      ? header.startsWith('Bearer ') && header.length <= 12007
        ? header.slice(7)
        : ''
      : sessions.session(req);
  }
  async function hasMfa(req: Request, user: Identity) {
    return Boolean(
      user.secondFactor ||
        (await services?.adminMfa?.verified(user.uid, binding(req), req.get('x-admin-mfa') || '')),
    );
  }
  async function admin(req: Request, _res: Response, next: NextFunction) {
    try {
      if (!(await accounts.isAdmin((req as unknown as AuthedRequest).identity.uid)))
        throw new HttpError(403, 'ADMIN_REQUIRED', 'Ação exclusiva da Blackout Create.');
      const user = (req as unknown as AuthedRequest).identity;
      enforceAdminSecondFactor(
        { secure: config.secure || config.ADMIN_MFA_REQUIRED },
        { ...user, secondFactor: await hasMfa(req, user) },
      );
      next();
    } catch (e) {
      next(e);
    }
  }
  app.post('/api/auth/session', rate('login', 15, 15 * 60000), async (req, res) => {
    const { idToken } = z
      .object({ idToken: z.string().min(10).max(12000) })
      .strict()
      .parse(req.body);
    let user: Identity;
    try {
      user = await auth.verifyIdToken(idToken);
    } catch {
      throw new HttpError(
        401,
        'TOKEN_INVALID',
        'Não foi possível validar o acesso. Entre novamente.',
      );
    }
    if (!user.emailVerified || !user.email)
      throw new HttpError(403, 'EMAIL_UNVERIFIED', 'Confirme seu e-mail antes de entrar.');
    const age = Math.floor(Date.now() / 1000) - user.authTime;
    if (!Number.isFinite(age) || age < -60 || age > 300)
      throw new HttpError(
        401,
        'RECENT_LOGIN_REQUIRED',
        'Faça login novamente para confirmar sua identidade.',
      );
    if (config.API_AUTH_MODE === 'bearer') {
      res.json({ ok: true });
      return;
    }
    let session: string;
    try {
      session = await auth.createSession(idToken, config.sessionMs);
    } catch {
      throw new HttpError(
        401,
        'SESSION_FAILED',
        'Não foi possível iniciar a sessão. Tente entrar novamente.',
      );
    }
    sessions.setSession(req, res, session);
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', (_req, res) => {
    sessions.clear(res);
    res.json({ ok: true });
  });
  app.get('/api/me', identity, async (req, res) => {
    const user = (req as unknown as AuthedRequest).identity,
      account = await accounts.own(user.uid);
    const platform = await accounts.isAdmin(user.uid);
    res.json({
      user: { email: user.email, uid: user.uid },
      role: platform ? 'platform' : account ? 'merchant' : 'unassigned',
      account,
      adminMfaRequired:
        platform && (config.secure || config.ADMIN_MFA_REQUIRED) && !(await hasMfa(req, user)),
    });
  });
  app.get('/api/store', identity, async (req, res) => {
    const account = await accounts.own((req as unknown as AuthedRequest).identity.uid);
    if (!account || account.access_status !== 'approved')
      throw new HttpError(403, 'STORE_NOT_APPROVED', 'Sua loja ainda não foi liberada.');
    const setup = await onboarding.read(account.id),
      runtime = services?.bots ? await services.bots.status(account.id) : null;
    res.json({
      account,
      botStatus:
        setup?.activation_status === 'active'
          ? 'activation_confirmed'
          : (setup?.activation_status ?? 'not_connected'),
      runtimeStatus: runtime
        ? runtime.online
          ? 'online'
          : runtime.provisioned
            ? 'offline'
            : 'unconfigured'
        : 'unknown',
      runtime,
      billingStartsOn: 'bot_activation',
      activationConfirmation: 'manual',
    });
  });
  const subscriptionOwner = async (req: Request) => {
    const uid = (req as unknown as AuthedRequest).identity.uid,
      account = await accounts.own(uid);
    if (!account || !subscriptions)
      throw new HttpError(403, 'SUBSCRIPTION_OWNER_REQUIRED', 'Assinatura indisponível.');
    return { uid, id: account.id, service: subscriptions };
  };
  app.get('/api/store/subscription', identity, async (req, res) => {
    const o = await subscriptionOwner(req);
    res.json(await o.service.read(o.id, o.uid));
  });
  app.get('/api/checkout/plans', rate('public-plans', 120, 60000), async (_req, res) => {
    if (!subscriptions)
      throw new HttpError(
        503,
        'SUBSCRIPTION_UNAVAILABLE',
        'Checkout temporariamente indisponível.',
      );
    res.json({ plans: (await subscriptions.settings()).plans });
  });
  app.get('/api/checkout/purchase', identity, async (req, res) => {
    if (!subscriptions)
      throw new HttpError(503, 'SUBSCRIPTION_UNAVAILABLE', 'Checkout indisponível.');
    res.json(await subscriptions.purchaseRead((req as unknown as AuthedRequest).identity));
  });
  app.post(
    '/api/checkout/purchase/create',
    identity,
    rate('purchase-create', 5, 600000),
    async (req, res) => {
      if (!subscriptions)
        throw new HttpError(503, 'SUBSCRIPTION_UNAVAILABLE', 'Checkout indisponível.');
      const user = (req as unknown as AuthedRequest).identity;
      await accounts.consumeRate('purchase-user:' + user.uid, 5, 600000);
      res.json(await subscriptions.purchaseCreate(user, req.body));
    },
  );
  app.post(
    '/api/checkout/purchase/check',
    identity,
    rate('purchase-check', 30, 60000),
    async (req, res) => {
      if (!subscriptions)
        throw new HttpError(503, 'SUBSCRIPTION_UNAVAILABLE', 'Checkout indisponível.');
      res.json(
        await subscriptions.purchaseCheck((req as unknown as AuthedRequest).identity, req.body),
      );
    },
  );
  app.post(
    '/api/store/subscription/create',
    identity,
    rate('subscription-create', 10, 600000),
    async (req, res) => {
      const o = await subscriptionOwner(req);
      res.json(await o.service.create(o.id, o.uid, req.body));
    },
  );
  app.post(
    '/api/store/subscription/check',
    identity,
    rate('subscription-check', 30, 60000),
    async (req, res) => {
      const o = await subscriptionOwner(req);
      res.json(await o.service.check(o.id, o.uid, req.body));
    },
  );
  app.get('/api/store/runtime', identity, async (req, res) => {
    const uid = (req as unknown as AuthedRequest).identity.uid;
    const account = await accounts.own(uid);
    if (!account || account.access_status !== 'approved')
      throw new HttpError(403, 'STORE_NOT_APPROVED', 'Sua loja ainda não foi liberada.');
    res.json({
      runtime: services?.bots ? await services.bots.status(account.id) : null,
      activation: (await services?.activation?.status(account.id)) ?? null,
      progress: services?.bots
        ? await readSetupProgress(services.bots.store, account.id, uid)
        : null,
    });
  });
  app.post(
    '/api/store/telegram-link',
    identity,
    rate('bot-owner-link', 5, 600000),
    async (req, res) => {
      z.object({}).strict().parse(req.body);
      const uid = (req as unknown as AuthedRequest).identity.uid,
        account = await accounts.own(uid);
      if (!account || !services?.bots)
        throw new HttpError(
          409,
          'RUNTIME_NOT_CONFIGURED',
          'A equipe ainda precisa preparar seu aplicativo de bot.',
        );
      res.json(await services.bots.ownerLink(account.id, uid));
    },
  );
  if (services?.bots && config.BOT_TOKEN_ENCRYPTION_KEY)
    app.use(
      '/api/store/manage',
      merchantConsoleRouter(
        new MerchantConsole(services.bots.store, config.BOT_TOKEN_ENCRYPTION_KEY, services.bots),
        accounts,
        identity,
        payments,
        purin,
        wallet,
        new StoreTest(services.bots.store, config.BOT_TOKEN_ENCRYPTION_KEY),
      ),
    );
  app.get('/api/onboarding', identity, async (req, res) => {
    res.json({ setup: await onboarding.own((req as unknown as AuthedRequest).identity.uid) });
  });
  app.post('/api/onboarding', identity, rate('bot-setup', 10, 15 * 60000), async (req, res) => {
    const input = botCredentials.parse(req.body);
    res.json({
      setup: await onboarding.save((req as unknown as AuthedRequest).identity.uid, input),
    });
  });
  app.post('/api/onboarding/submit', identity, async (req, res) => {
    z.object({}).strict().parse(req.body);
    const uid = (req as unknown as AuthedRequest).identity.uid;
    const setup = await onboarding.submit(uid);
    const account = await accounts.own(uid);
    if (account) await services?.activation?.enqueue(account.id);
    res.json({ setup });
  });
  app.post('/api/invitations/inspect', rate('inspect', 30, 15 * 60000), async (req, res) => {
    const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
    res.json(await accounts.inspect(token));
  });
  app.post(
    '/api/invitations/accept',
    identity,
    rate('accept', 15, 15 * 60000),
    async (req, res) => {
      const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
      res.json({
        account: await accounts.accept(token, (req as unknown as AuthedRequest).identity),
      });
    },
  );
  const mfaOwner = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!(await accounts.isAdmin((req as unknown as AuthedRequest).identity.uid)))
        throw new HttpError(403, 'ADMIN_REQUIRED', 'Ação exclusiva da Blackout Create.');
      next();
    } catch (e) {
      next(e);
    }
  };
  app.get('/api/security/admin-mfa/status', identity, mfaOwner, async (req, res) =>
    res.json({
      available: Boolean(services?.adminMfa),
      ...(services?.adminMfa
        ? await services.adminMfa.status((req as unknown as AuthedRequest).identity.uid)
        : { enabled: false }),
    }),
  );
  app.post('/api/security/admin-mfa/enroll', identity, mfaOwner, async (req, res) => {
    z.object({}).strict().parse(req.body);
    if (!services?.adminMfa)
      throw new HttpError(
        503,
        'MFA_UNAVAILABLE',
        'Configure o segredo de autenticação do administrador no servidor.',
      );
    const user = (req as unknown as AuthedRequest).identity;
    await accounts.consumeRate('mfa-enroll:' + tokenHash(user.uid), 5, 15 * 60000);
    res.json(await services.adminMfa.enroll(user));
  });
  app.post('/api/security/admin-mfa/verify', identity, mfaOwner, async (req, res) => {
    const { code } = z
      .object({ code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    if (!services?.adminMfa)
      throw new HttpError(
        503,
        'MFA_UNAVAILABLE',
        'Configure o segredo de autenticação do administrador no servidor.',
      );
    const user = (req as unknown as AuthedRequest).identity;
    await accounts.consumeRate('mfa-verify:' + tokenHash(user.uid), 10, 15 * 60000);
    res.json(await services.adminMfa.verify(user, binding(req), code));
  });
  app.use('/api/admin', identity, admin);
  app.get('/api/admin/health', rate('admin-health', 12, 60000), async (req, res) => {
    if (!services?.bots)
      throw new HttpError(503, 'HEALTH_UNAVAILABLE', 'Monitoramento indisponível.');
    res.json(await new AdminHealth(services.bots.store).read(req.query));
  });
  app.get('/api/admin/health/stores/:id', async (req, res) => {
    if (!services?.bots)
      throw new HttpError(503, 'HEALTH_UNAVAILABLE', 'Monitoramento indisponível.');
    res.json({
      account: await new AdminHealth(services.bots.store).account(idSchema.parse(req.params.id)),
    });
  });
  app.get('/api/admin/subscription-plans', async (_req, res) => {
    if (!subscriptions)
      throw new HttpError(503, 'SUBSCRIPTION_UNAVAILABLE', 'Assinaturas indisponíveis.');
    res.json(await subscriptions.settings());
  });
  app.post('/api/admin/subscription-plans', async (req, res) => {
    if (!subscriptions)
      throw new HttpError(503, 'SUBSCRIPTION_UNAVAILABLE', 'Assinaturas indisponíveis.');
    res.json(
      await subscriptions.configure((req as unknown as AuthedRequest).identity.uid, req.body),
    );
  });
  app.post('/api/admin/accounts/:id/subscription-plan', async (req, res) => {
    if (!subscriptions)
      throw new HttpError(503, 'SUBSCRIPTION_UNAVAILABLE', 'Assinaturas indisponíveis.');
    res.json(
      await subscriptions.assignInitial(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
        req.body,
      ),
    );
  });
  app.get('/api/admin/payments/purin', async (_req, res) => {
    if (!purin) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    res.json(await purin.platformStatus());
  });
  app.post('/api/admin/payments/purin/withdrawals', async (req, res) => {
    if (!purin) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await purin.setWithdrawals((req as unknown as AuthedRequest).identity.uid, enabled);
    res.json(await purin.platformStatus());
  });
  app.post(
    '/api/admin/payments/purin/connect',
    rate('purin-connect', 5, 60000),
    async (req, res) => {
      if (!purin) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
      res.json(await purin.connect((req as unknown as AuthedRequest).identity.uid, req.body));
    },
  );
  app.get('/api/admin/accounts/:id/purin', async (req, res) => {
    if (!purin) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    res.json(await purin.binding(idSchema.parse(req.params.id)));
  });
  app.post('/api/admin/accounts/:id/purin', async (req, res) => {
    if (!purin) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    res.json(
      await purin.bind(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
        req.body,
      ),
    );
  });
  app.get('/api/admin/accounts', async (req, res) => {
    const offset = z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
    const queue = z.enum(['all', 'activation']).default('all').parse(req.query.queue);
    res.json({ accounts: await accounts.list(offset, queue) });
  });
  app.get('/api/admin/audit', async (_req, res) => res.json({ events: await accounts.history() }));
  app.get('/api/admin/hosting', async (_req, res) =>
    res.json(
      services?.activation
        ? await services.activation.settings()
        : { connected: false, enabled: false },
    ),
  );
  app.post('/api/admin/hosting', rate('hosting-connect', 5, 600000), async (req, res) => {
    if (!services?.activation)
      throw new HttpError(503, 'HOSTING_UNAVAILABLE', 'Hospedagem automática indisponível.');
    res.json(
      await services.activation.connect((req as unknown as AuthedRequest).identity.uid, req.body),
    );
  });
  app.post('/api/admin/hosting/pause', async (_req, res) => {
    if (!services?.activation)
      throw new HttpError(503, 'HOSTING_UNAVAILABLE', 'Hospedagem automática indisponível.');
    res.json(await services.activation.pause());
  });
  app.get('/api/admin/accounts/:id/activation', async (req, res) =>
    res.json({
      activation: (await services?.activation?.status(idSchema.parse(req.params.id))) ?? null,
    }),
  );
  app.post('/api/admin/accounts/:id/activation/retry', async (req, res) => {
    z.object({}).strict().parse(req.body);
    if (!services?.activation)
      throw new HttpError(503, 'HOSTING_UNAVAILABLE', 'Hospedagem automática indisponível.');
    res.json({ activation: await services.activation.retry(idSchema.parse(req.params.id)) });
  });
  app.get('/api/admin/accounts/:id/bot-setup', async (req, res) => {
    res.json({ setup: await onboarding.read(idSchema.parse(req.params.id)) });
  });
  app.get('/api/admin/accounts/:id/bot-runtime', async (req, res) => {
    res.json({
      runtime: services?.bots ? await services.bots.status(idSchema.parse(req.params.id)) : null,
    });
  });
  app.post('/api/admin/accounts/:id/renew', async (req, res) => {
    const body = z
      .object({ requestId: z.uuid(), paymentConfirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    if (!services?.bots)
      throw new HttpError(503, 'BOT_RUNTIME_UNAVAILABLE', 'Operação de bot não configurada.');
    res.json(
      await services.bots.renew(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
        body.requestId,
      ),
    );
  });
  app.post('/api/admin/accounts/:id/bot-setup/review', async (req, res) => {
    const input = z
      .object({
        action: z.enum(['configure', 'request_changes']),
        revision: z.number().int().positive(),
        note: z.string().trim().max(500).default(''),
      })
      .strict()
      .refine((v) => v.action !== 'request_changes' || v.note.length >= 3)
      .parse(req.body);
    res.json({
      setup: await onboarding.review(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
        input,
      ),
    });
  });
  app.post(
    '/api/admin/accounts/:id/bot-setup/activate',
    rate('bot-activate', 15, 15 * 60000),
    async (req, res) => {
      const input = z
        .object({
          revision: z.number().int().positive(),
          deploymentReference: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_-]{6,120}$/),
          botTested: z.literal(true),
          ownerIdConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      if (services?.bots) {
        const id = idSchema.parse(req.params.id),
          status = await services.bots.status(id);
        const runtime = await services.bots.store.get('bot_runtimes/' + id);
        if (
          !status.provisioned ||
          !status.online ||
          !status.ownerVerified ||
          runtime?.application_id !== input.deploymentReference
        )
          throw new HttpError(
            409,
            'BOT_NOT_OPERATIONAL',
            'Prepare o aplicativo exclusivo, confirme o responsável pelo link do site e aguarde o bot ficar online antes de ativar.',
          );
      }
      res.json(
        await onboarding.activate(
          idSchema.parse(req.params.id),
          (req as unknown as AuthedRequest).identity.uid,
          input,
        ),
      );
    },
  );
  app.post(
    '/api/admin/accounts/:id/bot-token',
    rate('bot-secret', 10, 15 * 60000),
    async (req, res) => {
      z.object({}).strict().parse(req.body);
      res.json({
        token: await onboarding.reveal(
          idSchema.parse(req.params.id),
          (req as unknown as AuthedRequest).identity.uid,
        ),
      });
    },
  );
  app.post('/api/admin/accounts', rate('admin-create', 30, 60000), async (req, res) => {
    const value = registration.parse(req.body);
    res.status(201).json({
      account: await accounts.register(value, (req as unknown as AuthedRequest).identity.uid),
    });
  });
  app.post('/api/admin/accounts/:id/confirm-purchase', async (req, res) =>
    res.json({
      account: await accounts.confirm(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
      ),
    }),
  );
  app.post(
    '/api/admin/accounts/:id/invitations',
    rate('admin-invite', 30, 60000),
    async (req, res) => {
      const value = await accounts.invite(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
      );
      res.status(201).json({
        url: config.APP_ORIGIN + '/#/convite?token=' + value.token,
        expiresAt: value.expiresAt,
      });
    },
  );
  app.post('/api/admin/accounts/:id/approve', async (req, res) =>
    res.json({
      account: await accounts.approve(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
      ),
    }),
  );
  app.post('/api/admin/accounts/:id/restore', async (req, res) =>
    res.json({
      account: await accounts.restore(
        idSchema.parse(req.params.id),
        (req as unknown as AuthedRequest).identity.uid,
      ),
    }),
  );
  app.post('/api/admin/accounts/:id/suspend', async (req, res) => {
    const { reason } = z
      .object({ reason: z.string().trim().min(3).max(500) })
      .strict()
      .parse(req.body);
    res.json({
      account: await accounts.suspend(
        idSchema.parse(req.params.id),
        reason,
        (req as unknown as AuthedRequest).identity.uid,
      ),
    });
  });
  app.use('/api', (_req, _res, next) =>
    next(new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.')),
  );
  app.use(
    express.static(resolve('dist'), {
      index: 'index.html',
      maxAge: '1h',
      setHeaders(res, path) {
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        code: 'INVALID_INPUT',
        message: 'Confira os campos informados.',
        requestId: (req as unknown as AuthedRequest).requestId,
      });
      return;
    }
    if (err instanceof HttpError) {
      if (err.status === 429) res.set('Retry-After', '900');
      res.status(err.status).json({
        code: err.code,
        message: err.message,
        requestId: (req as unknown as AuthedRequest).requestId,
      });
      return;
    }
    const status = (err as { status?: number })?.status;
    if (status === 413 || err instanceof SyntaxError) {
      res
        .status(status === 413 ? 413 : 400)
        .json({ code: 'INVALID_BODY', message: 'Solicitação inválida ou muito grande.' });
      return;
    }
    console.error(
      JSON.stringify({
        event: 'request.failed',
        requestId: (req as unknown as AuthedRequest).requestId,
        category: err instanceof Error ? err.name : 'unknown',
      }),
    );
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Não foi possível concluir. Tente novamente.',
      requestId: (req as unknown as AuthedRequest).requestId,
    });
  });
  return app;
}
