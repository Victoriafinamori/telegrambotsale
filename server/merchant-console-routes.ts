import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from './types.js';
import type { Identity } from './types.js';
import type { AccountService } from './platform-contract.js';
import type { MerchantConsole } from './merchant-console.js';
import type { MercadoPagoPayments } from './mercado-pago.js';
import type { PurinCashPayments } from './purin-cash.js';
import type { PurinWallet } from './purin-wallet.js';
import type { StoreTest } from './store-test.js';
export function merchantConsoleRouter(
  console: MerchantConsole,
  accounts: AccountService,
  identity: RequestHandler,
  payments?: MercadoPagoPayments,
  purin?: PurinCashPayments,
  wallet?: PurinWallet,
  test?: StoreTest,
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
  router.get('/test', async (req, res) => {
    if (!test) throw new HttpError(503, 'TEST_UNAVAILABLE', 'Modo de teste indisponível.');
    const { id, uid } = owner(req);
    res.json(await test.read(id, uid));
  });
  router.post('/test/start', async (req, res) => {
    if (!test) throw new HttpError(503, 'TEST_UNAVAILABLE', 'Modo de teste indisponível.');
    const { id, uid } = owner(req);
    await accounts.consumeRate('store-test-start:' + id, 10, 60000);
    res.json(await test.start(id, uid, req.body));
  });
  router.post('/test/action', async (req, res) => {
    if (!test) throw new HttpError(503, 'TEST_UNAVAILABLE', 'Modo de teste indisponível.');
    const { id, uid } = owner(req);
    await accounts.consumeRate('store-test-action:' + id, 60, 60000);
    res.json(await test.action(id, uid, req.body));
  });
  router.get('/wallet', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req);
    res.json(await wallet.read(id, { uid }));
  });
  router.get('/wallet/drafts/:id', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req);
    res.json(await wallet.draft(id, { uid }, z.uuid().parse(req.params.id)));
  });
  router.post('/wallet/keys', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req);
    await accounts.consumeRate('wallet-keys:' + id, 20, 60000);
    res.json(await wallet.saveKey(id, { uid }, req.body));
  });
  router.post('/wallet/keys/remove', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req);
    const { keyId } = z.object({ keyId: z.string() }).strict().parse(req.body);
    res.json(await wallet.removeKey(id, { uid }, keyId));
  });
  router.post('/wallet/prepare', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req);
    await accounts.consumeRate('wallet-prepare:' + id, 10, 60000);
    res.json(await wallet.prepare(id, { uid }, req.body));
  });
  router.post('/wallet/approve', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req);
    await accounts.consumeRate('wallet-approve:' + id, 10, 60000);
    res.json(await wallet.requestApproval(id, uid, req.body));
  });
  router.post('/wallet/cancel', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req),
      body = z.object({ draftId: z.uuid() }).strict().parse(req.body);
    await wallet.cancel(id, { uid }, body.draftId);
    res.json({ ok: true });
  });
  router.post('/wallet/status', async (req, res) => {
    if (!wallet) throw new HttpError(503, 'WALLET_UNAVAILABLE', 'Carteira indisponível.');
    const { id, uid } = owner(req),
      body = z.object({ draftId: z.uuid() }).strict().parse(req.body);
    res.json(await wallet.sync(id, { uid }, body.draftId));
  });
  router.post('/payments/purin/request', async (req, res) => {
    if (!purin) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    z.object({}).strict().parse(req.body);
    const { id, uid } = owner(req);
    res.json(await purin.requestActivation(id, uid));
  });
  router.get('/payments', async (req, res) => {
    if (!payments) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    const { id, uid } = owner(req);
    res.json(await payments.settings(id, uid));
  });
  router.post('/payments', async (req, res) => {
    if (!payments) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    const { id, uid } = owner(req);
    await payments.saveSettings(id, uid, req.body);
    res.json({ ok: true });
  });
  router.post('/payments/connect', async (req, res) => {
    if (!payments) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Pagamentos indisponíveis.');
    const { id, uid } = owner(req);
    await accounts.consumeRate('mp-connect:' + uid, 5, 60000);
    res.json(await payments.connect(id, uid, req.body));
  });
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
  router.post('/categories/manage', async (req, res) => {
    const { id, uid } = owner(req);
    await console.manageCategory(id, uid, req.body);
    res.json({ ok: true });
  });
  router.post('/products/order', async (req, res) => {
    const { id, uid } = owner(req);
    await console.moveProduct(id, uid, req.body);
    res.json({ ok: true });
  });
  router.get('/stock', async (req, res) => {
    const { id, uid } = owner(req);
    res.set('Cache-Control', 'no-store');
    res.json(await console.inventory(id, uid, z.string().parse(req.query.productId)));
  });
  router.post('/stock/manage', async (req, res) => {
    const { id, uid } = owner(req);
    await console.manageStock(id, uid, req.body);
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
