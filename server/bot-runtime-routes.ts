import { Router, json } from 'express';
import { z } from 'zod';
import type { BotStore } from './bot-store.js';
import type { RuntimeAccess } from './bot-types.js';
import { HttpError } from './types.js';
import type { AccountService } from './platform-contract.js';
import type { MercadoPagoPayments } from './mercado-pago.js';
import { fastNavigation } from './bot-navigation.js';

export function botRuntimeRouter(
  bots: BotStore,
  accounts: AccountService,
  payments?: Pick<MercadoPagoPayments, 'checkFromBot'>,
) {
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
  router.post('/updates', async (req, res) => {
    const access = accesses.get(req)!;
    const callback = req.body?.callback_query;
    const inline = req.query.dispatch === 'navigation' && fastNavigation(callback?.data);
    const result = await bots.process(access, req.body, undefined, inline);
    if (payments && typeof callback?.data === 'string' && callback.data.startsWith('pix-check:')) {
      await accounts.consumeRate(
        'pix-check:' + access.accountId + ':' + String(callback.from?.id),
        10,
        60000,
      );
      await payments.checkFromBot(
        access.accountId,
        String(callback.from?.id),
        callback.data.slice(10),
      );
    }
    if (inline && !('effects' in result)) {
      const effects = await bots.claimNavigation(access, result.effectIds);
      if (effects !== null) return res.json({ ...result, effects });
    }
    res.json(result);
  });
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
  router.post('/effects/ack-batch', async (req, res) => {
    const rows = z
      .array(
        z
          .object({
            id: effectId,
            lease: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
            result: z.enum(['sent', 'uncertain', 'failed', 'retry']),
            errorCode: z.number().int().min(0).max(599).optional(),
            retryAfter: z.number().int().min(1).max(86400).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .parse(req.body);
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new HttpError(400, 'EFFECT_IDS_DUPLICATED', 'Confirmação inválida.');
    if (await bots.acknowledgeNavigation(accesses.get(req)!, rows)) return res.json({ ok: true });
    for (const row of rows)
      await bots.acknowledge(
        accesses.get(req)!,
        row.id,
        row.lease,
        row.result,
        row.errorCode,
        row.retryAfter,
      );
    res.json({ ok: true });
  });
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
