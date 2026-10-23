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
  accounts: Accounts,
  auth: IdentityProvider,
  verifyBot?: BotVerifier,
) {
  const app = express(),
    sessions = new SessionTransport(config),
    onboarding = new BotOnboarding(
      accounts,
      config.BOT_TOKEN_ENCRYPTION_KEY,
      verifyBot ?? (config.FIREBASE_AUTH_EMULATOR_HOST ? verifyDemoBot : undefined),
    );
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
          imgSrc: ["'self'", 'data:'],
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
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) =>
    res.json({
      firebase: publicFirebaseOptions(config),
      emulatorHost: config.FIREBASE_AUTH_EMULATOR_HOST || null,
    }),
  );
  app.get('/api/security/csrf', (req, res) => {
    const token = randomBytes(32).toString('base64url');
    sessions.setCsrf(req, res, token);
    res.json({ token });
  });
  app.use('/api', (req, _res, next) => {
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
      const value = sessions.session(req);
      if (!value) throw new Error('missing');
      const user = await auth.verifySession(value);
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
  async function admin(req: Request, _res: Response, next: NextFunction) {
    try {
      if (!(await accounts.isAdmin((req as unknown as AuthedRequest).identity.uid)))
        throw new HttpError(403, 'ADMIN_REQUIRED', 'Ação exclusiva da Blackout Create.');
      enforceAdminSecondFactor(config, (req as unknown as AuthedRequest).identity);
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
    res.json({
      user: { email: user.email, uid: user.uid },
      role: (await accounts.isAdmin(user.uid)) ? 'platform' : account ? 'merchant' : 'unassigned',
      account,
    });
  });
  app.get('/api/store', identity, async (req, res) => {
    const account = await accounts.own((req as unknown as AuthedRequest).identity.uid);
    if (!account || account.access_status !== 'approved')
      throw new HttpError(403, 'STORE_NOT_APPROVED', 'Sua loja ainda não foi liberada.');
    const setup = await onboarding.read(account.id);
    res.json({
      account,
      botStatus:
        setup?.activation_status === 'active'
          ? 'activation_confirmed'
          : (setup?.activation_status ?? 'not_connected'),
      runtimeStatus: 'unknown',
      billingStartsOn: 'bot_activation',
      activationConfirmation: 'manual',
    });
  });
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
    res.json({ setup: await onboarding.submit((req as unknown as AuthedRequest).identity.uid) });
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
  app.use('/api/admin', identity, admin);
  app.get('/api/admin/accounts', async (req, res) => {
    const offset = z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
    const queue = z.enum(['all', 'activation']).default('all').parse(req.query.queue);
    res.json({ accounts: await accounts.list(offset, queue) });
  });
  app.get('/api/admin/audit', async (_req, res) => res.json({ events: await accounts.history() }));
  app.get('/api/admin/accounts/:id/bot-setup', async (req, res) => {
    res.json({ setup: await onboarding.read(idSchema.parse(req.params.id)) });
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
