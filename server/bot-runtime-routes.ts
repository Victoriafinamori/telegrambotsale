import { Router, json } from 'express';
import { z } from 'zod';
import type { BotStore } from './bot-store.js';
import type { RuntimeAccess } from './bot-types.js';
import { HttpError } from './types.js';
import type { AccountService } from './platform-contract.js';

export function botRuntimeRouter(bots: BotStore, accounts: AccountService) {
  const router = Router(),
    accesses = new WeakMap<object, RuntimeAccess>();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(async (req, _res, next) => {
    try {
      if (req.get('origin'))
        throw new HttpError(403, 'RUNTIME_SERVER_ONLY', 'Use a conexão privada de servidor.');
      const auth = await bots.authenticate(
        (req.get('authorization') ?? '').replace(/^Bearer /, ''),
      );
      await accounts.consumeRate('bot-runtime:' + auth.accountId, 600, 60000);
      accesses.set(req, auth);
      next();
    } catch (e) {
      next(e);
    }
  });
  router.use(json({ limit: '48kb', strict: true }));
  router.get('/config', async (req, res) => res.json(await bots.configuration(accesses.get(req)!)));
  router.post('/updates', async (req, res) =>
    res.json(await bots.process(accesses.get(req)!, req.body)),
  );
  router.post('/heartbeat', async (req, res) => {
    const body = z
      .object({ botName: z.string().trim().min(1).max(128).optional() })
      .strict()
      .parse(req.body);
    res.json(await bots.tick(accesses.get(req)!, body.botName));
  });
  router.get('/effects', async (req, res) =>
    res.json({ ids: await bots.pending(accesses.get(req)!) }),
  );
  const effectId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  router.post('/effects/:id/claim', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json({ effect: await bots.claim(accesses.get(req)!, effectId.parse(req.params.id)) });
  });
  router.post('/effects/:id/ack', async (req, res) => {
    const body = z
      .object({
        lease: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
        result: z.enum(['sent', 'uncertain', 'failed', 'retry']),
        errorCode: z.number().int().min(0).max(599).optional(),
        retryAfter: z.number().int().min(1).max(86400).optional(),
      })
      .strict()
      .parse(req.body);
    await bots.acknowledge(
      accesses.get(req)!,
      effectId.parse(req.params.id),
      body.lease,
      body.result,
      body.errorCode,
      body.retryAfter,
    );
    res.json({ ok: true });
  });
  return router;
}
