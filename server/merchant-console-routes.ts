import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from './types.js';
import type { Identity } from './types.js';
import type { AccountService } from './platform-contract.js';
import type { MerchantConsole } from './merchant-console.js';
export function merchantConsoleRouter(
  console: MerchantConsole,
  accounts: AccountService,
  identity: RequestHandler,
) {
  const router = Router(),
    owners = new WeakMap<object, { id: string; uid: string }>();
  router.use(identity, async (req, _res, next) => {
    try {
      const uid = (req as unknown as { identity: Identity }).identity.uid,
        account = await accounts.own(uid);
      if (!account || account.access_status !== 'approved')
        throw new HttpError(403, 'STORE_NOT_APPROVED', 'Sua loja precisa estar liberada.');
      await accounts.consumeRate('merchant-console:' + uid, 120, 60000);
      owners.set(req, { id: account.id, uid });
      next();
    } catch (e) {
      next(e);
    }
  });
  const owner = (req: object) => owners.get(req)!;
  router.get('/', async (req, res) => {
    const { id, uid } = owner(req);
    res.json(await console.read(id, uid));
  });
  router.post('/settings', async (req, res) => {
    const { id, uid } = owner(req);
    await console.saveSettings(id, uid, req.body);
    res.json({ ok: true });
  });
  router.post('/products', async (req, res) => {
    const { id, uid } = owner(req);
    res.json(await console.saveProduct(id, uid, req.body));
  });
  router.post('/categories', async (req, res) => {
    const { id, uid } = owner(req);
    await console.createCategory(id, uid, req.body);
    res.json({ ok: true });
  });
  router.post('/stock', async (req, res) => {
    const { id, uid } = owner(req);
    await console.addStock(id, uid, req.body);
    res.json({ ok: true });
  });
  router.post('/coupons', async (req, res) => {
    const { id, uid } = owner(req);
    await console.coupon(id, uid, req.body);
    res.json({ ok: true });
  });
  router.get('/orders', async (req, res) => {
    const { id, uid } = owner(req),
      cursor = z
        .string()
        .regex(/^[a-f0-9]{0,16}$/)
        .parse(req.query.cursor ?? '');
    res.json(await console.orders(id, uid, cursor, req.query.pending === 'true'));
  });
  router.get('/notices', async (req, res) => {
    const { id, uid } = owner(req);
    res.json({ notices: await console.notices(id, uid) });
  });
  router.post('/notices', async (req, res) => {
    const { id, uid } = owner(req);
    res.json(await console.draft(id, uid, req.body));
  });
  router.post('/commands', async (req, res) => {
    const { id, uid } = owner(req);
    res.json(await console.command(id, uid, req.body));
  });
  router.post('/media', async (req, res) => {
    const { id, uid } = owner(req);
    await accounts.consumeRate('merchant-upload:' + uid, 10, 60000);
    res.json(await console.upload(id, uid, req.body));
  });
  router.get('/media/:fileId', async (req, res) => {
    const { id, uid } = owner(req),
      asset = z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,512}$/)
        .parse(req.params.fileId),
      file = await console.image(id, uid, asset);
    res.set(
      'Content-Type',
      file.type.startsWith('image/') ? file.type : 'application/octet-stream',
    );
    res.set('Content-Disposition', 'inline; filename="imagem"');
    res.send(Buffer.from(file.bytes));
  });
  router.get('/orders/:orderId/receipt', async (req, res) => {
    const { id, uid } = owner(req),
      oid = z
        .string()
        .regex(/^[a-f0-9]{16}$/)
        .parse(req.params.orderId),
      file = await console.receipt(id, uid, oid);
    res.set(
      'Content-Type',
      file.type.startsWith('image/') || file.type === 'application/pdf'
        ? file.type
        : 'application/octet-stream',
    );
    res.set('Content-Disposition', 'inline; filename="comprovante"');
    res.send(Buffer.from(file.bytes));
  });
  return router;
}
