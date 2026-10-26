import { Router } from 'express';
import { z } from 'zod';
import type { MercadoPagoPayments } from './mercado-pago.js';
import { HttpError } from './types.js';
export function publicPaymentRouter(payments: MercadoPagoPayments) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.post('/details', async (req, res) => res.json(await payments.details(req.body)));
  router.post('/create', async (req, res) => res.json(await payments.create(req.body)));
  router.post('/refresh', async (req, res) => res.json(await payments.refresh(req.body)));
  return router;
}
export function mercadoPagoWebhook(payments: MercadoPagoPayments) {
  const router = Router();
  router.post('/:accountId/:connection', async (req, res) => {
    const account = z.uuid().parse(req.params.accountId),
      connection = z.union([z.literal('current'), z.uuid()]).parse(req.params.connection);
    const id = z
      .string()
      .regex(/^\d{1,30}$/)
      .parse(req.query['data.id']);
    if (String(req.body?.data?.id) !== id || req.body?.type !== 'payment')
      throw new HttpError(400, 'MP_NOTIFICATION_INVALID', 'Notificação inválida.');
    await payments.notify(
      account,
      connection,
      id,
      req.get('x-signature') ?? '',
      req.get('x-request-id') ?? '',
    );
    res.json({ ok: true });
  });
  return router;
}
