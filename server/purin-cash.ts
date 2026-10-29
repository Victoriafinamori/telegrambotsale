import { restoreShared, finishShared } from './resale-stock.js';
import { creditProof, recordCommission } from './resale-finance.js';
import { restoreStock, syncStock } from './stock-modes.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import type { BotStore } from './bot-store.js';
import type { Shop, Order } from './bot-types.js';
import { botRoot, botPath, botTransaction } from './bot-data.js';
import { SecretVault } from './secret-vault.js';
import { money } from './bot-appearance.js';
import { tokenHash } from './accounts.js';
import { HttpError } from './types.js';
import { checkoutInput } from './mercado-pago.js';
import { recordPaid } from './bot-orders.js';

const root = 'platform_payments/purincash';
const connectionPath = (generation: string) => root + '/connections/' + generation;
const attemptPath = (id: string, oid: string) =>
  `merchant_payment_secrets/${id}/purin_payments/${oid}`;
const subaccountId = z.string().regex(/^sacc_[A-Za-z0-9_-]{1,120}$/);
const chargeId = z.string().regex(/^psc_[A-Za-z0-9_-]{1,120}$/);
const missing = () =>
  new HttpError(404, 'CHECKOUT_NOT_FOUND', 'Pagamento indisponível. Abra o pedido no Telegram.');
const uncertain = () =>
  new HttpError(
    409,
    'PURIN_RECONCILIATION',
    'A cobrança está em conferência. Não gere outro pedido nem pague duas vezes. Use Verificar confirmação ou fale com o suporte da loja.',
  );
const verificationMessage =
  'A loja precisa concluir “Verificar Chave PIX” na Carteira da PurinCash antes de receber pagamentos. Avise o responsável pela loja.';
export class PurinProviderError extends HttpError {
  constructor(
    readonly providerStatus: number,
    code: string,
    message: string,
  ) {
    super(providerStatus < 500 ? 409 : 502, code, message);
  }
  get definitiveRejection() {
    return [400, 401, 403, 404, 422].includes(this.providerStatus);
  }
}

export function validPurinSignature(raw: Buffer, signature: string, secret: string) {
  return (
    /^[a-f0-9]{64}$/.test(signature) &&
    timingSafeEqual(
      createHmac('sha256', secret).update(raw).digest(),
      Buffer.from(signature, 'hex'),
    )
  );
}

export const BLACKOUT_PURIN_FEES = Object.freeze({
  feePercent: 12,
  feeFixedCents: 0,
  payoutFeePercent: 0,
  payoutFeeFixedCents: 100,
});

export class PurinCashPayments {
  private vault: SecretVault;
  constructor(
    readonly store: DocumentStore,
    key: string,
    readonly bots: BotStore,
    readonly webOrigin: string,
    readonly apiOrigin: string,
    private request: typeof fetch = fetch,
    readonly now = () => new Date(),
    private liveEnabled = true,
  ) {
    this.vault = new SecretVault(key);
    for (const origin of [webOrigin, apiOrigin]) {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1'))
        throw Error('Invalid payment origin');
    }
  }
  private async provider(token: string, path: string, body?: Doc, method?: 'PUT'): Promise<Doc> {
    if (!this.liveEnabled)
      throw new HttpError(
        503,
        'PAYMENT_DEMO_ONLY',
        'Pagamentos reais estão desativados neste ambiente.',
      );
    let response: Response;
    try {
      response = await this.request('https://api.purincash.com/v1' + path, {
        method: method ?? (body ? 'POST' : 'GET'),
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new HttpError(
        502,
        'PURIN_UNAVAILABLE',
        'PurinCash indisponível. A cobrança será conferida antes de qualquer nova tentativa.',
      );
    }
    const text = await response.text();
    if (!response.ok) {
      let message = '';
      try {
        if (text.length <= 16000) message = String(JSON.parse(text).error ?? '');
      } catch {
        /* Never expose untrusted response bodies. */
      }
      if (response.status === 403 && message.includes('Verificar Chave PIX'))
        throw new PurinProviderError(403, 'PURIN_RECEIVER_UNVERIFIED', verificationMessage);
      throw new PurinProviderError(
        response.status,
        'PURIN_REJECTED',
        [401, 403].includes(response.status)
          ? 'Confira a chave e as permissões PurinCash na administração da Blackout.'
          : 'A PurinCash não concluiu a solicitação. Confira a subconta e a habilitação da conta.',
      );
    }
    if (text.length > 2000000)
      throw new HttpError(502, 'PURIN_RESPONSE_INVALID', 'Resposta de pagamento inválida.');
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, 'PURIN_RESPONSE_INVALID', 'Resposta de pagamento inválida.');
    }
  }
  private async credentials(generation: string) {
    const saved = await this.store.get(connectionPath(generation));
    if (!saved) throw missing();
    return JSON.parse(this.vault.open(saved.ciphertext, 'purin:' + generation)) as {
      token: string;
      secret: string;
    };
  }
  private audit(tx: DocumentTransaction, id: string, actor: string, action: string) {
    const key = randomUUID();
    tx.set('platform_audit/' + key, {
      id: key,
      account_id: id,
      actor_uid: actor,
      action,
      created_at: this.now(),
    });
  }
  async platformStatus() {
    const pointer = await this.store.get(root);
    return {
      connected: Boolean(pointer?.generation),
      webhookUrl: pointer?.generation
        ? this.apiOrigin + '/payments/purincash/' + pointer.generation
        : '',
      commissionCents: 0,
      withdrawalsEnabled: pointer?.withdrawals_enabled === true,
    };
  }
  // Server-only provider facade; affiliate allocation is frozen in the invoice snapshot.
  async subscriptionGateway(generation?: string) {
    const pointer = await this.store.get(root);
    const current = generation ?? pointer?.generation;
    if (!current) throw new HttpError(409, 'PURIN_NOT_CONNECTED', 'Conecte a PurinCash primeiro.');
    z.uuid().parse(current);
    const credentials = await this.credentials(current);
    return {
      generation: current as string,
      create: (body: Doc) => this.provider(credentials.token, '/charges', body),
      read: (id: string) => this.provider(credentials.token, '/charges/' + chargeId.parse(id)),
      list: () => this.provider(credentials.token, '/charges?limit=100'),
      subaccount: (id: string) =>
        this.provider(credentials.token, '/subaccounts/' + subaccountId.parse(id)),
      ledger: async (id: string, paidAt?: unknown, paymentId?: string) => {
        const sub = subaccountId.parse(id),
          time = typeof paidAt === 'string' ? Date.parse(paidAt) : NaN;
        const window = Number.isFinite(time)
          ? '&from=' +
            encodeURIComponent(new Date(time - 60000).toISOString()) +
            '&to=' +
            encodeURIComponent(new Date(time + 60000).toISOString())
          : '';
        for (let offset = 0; offset < 1000; offset += 100) {
          const page = await this.provider(
            credentials.token,
            '/subaccounts/' + sub + '/transactions?limit=100&offset=' + offset + window,
          );
          if (
            !paymentId ||
            page.transactions?.some((r: Doc) => r.type === 'sale' && r.refId === paymentId) ||
            !page.transactions ||
            page.transactions.length < 100
          )
            return page;
        }
        return { subaccountId: sub, transactions: [] };
      },
      verify: (raw: Buffer, signature: string) =>
        validPurinSignature(raw, signature, credentials.secret),
    };
  }
  async setWithdrawals(actor: string, enabled: boolean) {
    await botTransaction(this.store, async (tx) => {
      const settings = await tx.get(root);
      if (!settings?.generation)
        throw new HttpError(409, 'PURIN_NOT_CONNECTED', 'Conecte a PurinCash primeiro.');
      tx.set(root, { ...settings, withdrawals_enabled: enabled });
      this.audit(
        tx,
        'platform',
        actor,
        enabled ? 'platform.withdrawals_enabled' : 'platform.withdrawals_disabled',
      );
    });
  }
  async connect(actor: string, raw: unknown) {
    const input = z
      .object({
        accessToken: z
          .string()
          .trim()
          .regex(/^ps_live_[A-Za-z0-9_-]{16,500}$/),
        webhookSecret: z.string().trim().min(16).max(512),
      })
      .strict()
      .parse(raw);
    // Read-only validation; no charge, fee, transfer or payout is made here.
    await this.provider(input.accessToken, '/subaccounts?limit=1');
    await this.provider(input.accessToken, '/charges?limit=1');
    const generation = randomUUID();
    await botTransaction(this.store, async (tx) => {
      tx.set(connectionPath(generation), {
        ciphertext: this.vault.seal(
          JSON.stringify({ token: input.accessToken, secret: input.webhookSecret }),
          'purin:' + generation,
        ),
        created_at: this.now(),
      });
      const settings = await tx.get(root);
      tx.set(root, { ...settings, generation, updated_at: this.now(), withdrawals_enabled: false });
      this.audit(tx, 'platform', actor, 'platform.purincash_connected');
    });
    return this.platformStatus();
  }
  async binding(id: string) {
    const shop = await this.store.get(botRoot(id));
    return {
      subaccountId: shop?.purin_subaccount ?? '',
      connected: Boolean(shop?.purin_connection && shop?.purin_subaccount),
      requested: shop?.purin_requested === true,
      merchantId: id,
    };
  }
  async bind(id: string, actor: string, raw: unknown) {
    const input = z.object({ subaccountId }).strict().parse(raw),
      pointer = await this.store.get(root);
    if (!pointer?.generation)
      throw new HttpError(409, 'PURIN_NOT_CONNECTED', 'Conecte a conta principal primeiro.');
    const credentials = await this.credentials(pointer.generation),
      sub = await this.provider(credentials.token, '/subaccounts/' + input.subaccountId);
    if (
      sub.subaccountId !== input.subaccountId ||
      sub.active !== true ||
      (sub.externalId && sub.externalId !== id)
    )
      throw new HttpError(
        409,
        'PURIN_SUBACCOUNT_MISMATCH',
        'Subconta inativa ou vinculada a outro identificador. Use o ID deste lojista como identificador externo.',
      );
    // Reserve ownership before changing provider settings. Concurrent binds cannot
    // configure another merchant's subaccount, even without an externalId.
    await botTransaction(this.store, async (tx) => {
      const [claim, account, shop, current] = await Promise.all([
        tx.get('purin_subaccount_claims/' + input.subaccountId),
        tx.get('merchant_accounts/' + id),
        tx.get(botRoot(id)),
        tx.get(root),
      ]);
      if (!account || !shop || current?.generation !== pointer.generation) throw missing();
      if (claim && claim.account_id !== id)
        throw new HttpError(
          409,
          'PURIN_SUBACCOUNT_USED',
          'Esta subconta já pertence a outro lojista da Blackout.',
        );
      tx.set('purin_subaccount_claims/' + input.subaccountId, {
        account_id: id,
        created_at: claim?.created_at ?? this.now(),
      });
    });
    await this.applySubaccountFees(input.subaccountId, credentials.token);
    await botTransaction(this.store, async (tx) => {
      const [account, shop, claimed, current] = await Promise.all([
        tx.get('merchant_accounts/' + id),
        tx.get(botRoot(id)),
        tx.get('purin_subaccount_claims/' + input.subaccountId),
        tx.get(root),
      ]);
      if (!account || !shop || current?.generation !== pointer.generation) throw missing();
      if (claimed && claimed.account_id !== id)
        throw new HttpError(
          409,
          'PURIN_SUBACCOUNT_USED',
          'Esta subconta já pertence a outro lojista da Blackout.',
        );
      tx.set('purin_subaccount_claims/' + input.subaccountId, {
        account_id: id,
        created_at: this.now(),
      });
      tx.set(botRoot(id), {
        ...shop,
        purin_connection: pointer.generation,
        purin_subaccount: input.subaccountId,
        portal_revision: (shop.portal_revision ?? 0) + 1,
      });
      this.audit(tx, id, actor, 'store.purin_subaccount_bound');
    });
    return this.binding(id);
  }
  private async applySubaccountFees(sid: string, token: string) {
    await this.provider(token, '/subaccounts/' + sid, BLACKOUT_PURIN_FEES, 'PUT');
    const sub = await this.provider(token, '/subaccounts/' + sid);
    if (
      sub.subaccountId !== sid ||
      Object.entries(BLACKOUT_PURIN_FEES).some(([key, value]) => sub[key] !== value)
    )
      throw new HttpError(
        409,
        'PURIN_FEES_NOT_CONFIRMED',
        'A Purin ainda não confirmou as taxas da subconta.',
      );
  }
  async applyFees(id: string, actor: string) {
    const shop = await this.store.get(botRoot(id));
    if (!shop?.purin_connection || !shop.purin_subaccount) throw missing();
    const sid = subaccountId.parse(shop.purin_subaccount);
    const claim = await this.store.get('purin_subaccount_claims/' + sid);
    if (claim?.account_id !== id) throw missing();
    const credentials = await this.credentials(shop.purin_connection);
    await this.applySubaccountFees(sid, credentials.token);
    await botTransaction(this.store, async (tx) => {
      this.audit(tx, id, actor, 'store.purin_fees_12_percent_and_100_cents');
    });
    return { ...BLACKOUT_PURIN_FEES };
  }
  async requestActivation(id: string, uid: string) {
    await botTransaction(this.store, async (tx) => {
      const [account, shop] = await Promise.all([
        tx.get('merchant_accounts/' + id),
        tx.get(botRoot(id)),
      ]);
      if (!shop || account?.firebase_uid !== uid || account.access_status !== 'approved')
        throw missing();
      tx.set(botRoot(id), { ...shop, purin_requested: true });
      this.audit(tx, id, uid, 'store.purin_activation_requested');
    });
    return this.binding(id);
  }
  private async checkout(tx: DocumentTransaction, base: z.infer<typeof checkoutInput>) {
    const order = (await tx.get(botPath(base.accountId, 'orders', base.orderId))) as Order | null;
    if (
      !order ||
      order.payment_method !== 'purincash' ||
      !/^[a-f0-9]{64}$/.test(order.checkout_token_hash ?? '') ||
      !timingSafeEqual(Buffer.from(tokenHash(base.key)), Buffer.from(order.checkout_token_hash!))
    )
      throw missing();
    return order;
  }
  async details(raw: unknown) {
    const base = checkoutInput.parse(raw);
    return botTransaction(this.store, async (tx) => {
      const order = await this.checkout(tx, base),
        shop = await tx.get(botRoot(base.accountId)),
        attempt = await tx.get(attemptPath(base.accountId, base.orderId));
      const open = order.status === 'awaiting_payment' && order.expires_at > this.now();
      const qr =
        open && attempt?.qr_ciphertext
          ? JSON.parse(
              this.vault.open(attempt.qr_ciphertext, `purin-qr:${base.accountId}:${base.orderId}`),
            )
          : {};
      return {
        provider: 'purincash',
        title: shop?.title ?? 'Loja',
        orderId: order.id,
        total: order.total,
        items: order.items.map((i) => ({ title: i.title, quantity: i.quantity })),
        status: order.status,
        expiresAt: order.expires_at.toISOString(),
        open,
        chargeState:
          attempt?.state === 'creating' &&
          this.now().getTime() - attempt.started_at.getTime() >= 60000
            ? 'uncertain'
            : (attempt?.state ?? (attempt ? 'uncertain' : 'not_created')),
        paymentError:
          attempt?.last_failure === 'PURIN_RECEIVER_UNVERIFIED' ? verificationMessage : '',
        qrCode: qr.code ?? '',
        qrBase64: qr.image ?? '',
      };
    });
  }
  async create(raw: unknown) {
    const { payer: _payer, ...base } = z
      .object({ ...checkoutInput.shape, payer: z.unknown().optional() })
      .strict()
      .parse(raw);
    const prepared = await botTransaction(this.store, async (tx) => {
      const order = await this.checkout(tx, base);
      const [shop, account, setup, attempt] = await Promise.all([
        tx.get(botRoot(base.accountId)),
        tx.get('merchant_accounts/' + base.accountId),
        tx.get('merchant_bot_setup/' + base.accountId),
        tx.get(attemptPath(base.accountId, base.orderId)),
      ]);
      if (order.status !== 'awaiting_payment' || order.expires_at <= this.now())
        throw new HttpError(409, 'ORDER_CLOSED', 'Pedido encerrado. Consulte o Telegram.');
      if (
        !shop ||
        account?.access_status !== 'approved' ||
        setup?.activation_status !== 'active' ||
        account.paid_through <= this.now()
      )
        throw missing();
      if (order.total < 80)
        throw new HttpError(
          400,
          'PURIN_MINIMUM',
          'O mínimo para Pix automático Blackout é R$ 0,80.',
        );
      if (!order.purin_connection || !order.purin_subaccount) throw missing();
      return { order, first: !attempt || attempt.state === 'rejected', attempt };
    });
    const order = prepared.order,
      credentials = await this.credentials(order.purin_connection!);
    if (!prepared.first) {
      if (order.purin_payment_id) await this.checkFromBot(base.accountId, order.buyer_id, order.id);
      else if (
        prepared.attempt?.state === 'creating' &&
        this.now().getTime() - prepared.attempt.started_at.getTime() < 60000
      )
        return this.details(base);
      else await this.reconcile(base.accountId, order, credentials.token);
      return this.details(base);
    }
    const sub = await this.provider(
      credentials.token,
      '/subaccounts/' + subaccountId.parse(order.purin_subaccount),
    );
    if (sub.active !== true || sub.subaccountId !== order.purin_subaccount)
      throw new HttpError(
        409,
        'PURIN_SUBACCOUNT_INACTIVE',
        'Subconta indisponível. Fale com o suporte da loja.',
      );
    // Preflight cannot create a charge. Claim the single POST only AFTER it succeeds.
    const claim = randomUUID();
    const acquired = await botTransaction(this.store, async (tx) => {
      const [current, attempt] = await Promise.all([
        tx.get(botPath(base.accountId, 'orders', order.id)),
        tx.get(attemptPath(base.accountId, order.id)),
      ]);
      if (!current || current.status !== 'awaiting_payment' || current.expires_at <= this.now())
        throw new HttpError(409, 'ORDER_CLOSED', 'Pedido encerrado. Consulte o Telegram.');
      if (current.purin_payment_id || (attempt && attempt.state !== 'rejected')) return false;
      tx.set(attemptPath(base.accountId, order.id), {
        generation: order.purin_connection,
        subaccount: order.purin_subaccount,
        started_at: this.now(),
        state: 'creating',
        claim,
      });
      return true;
    });
    if (!acquired) return this.details(base);
    let payment: Doc;
    try {
      payment = await this.provider(credentials.token, '/charges', {
        valueCents: order.total,
        description: 'Pedido Blackout ' + order.id,
        expiresIn: Math.max(
          60,
          Math.floor((order.expires_at.getTime() - this.now().getTime()) / 1000) - 30,
        ),
        callbackUrl: `${this.apiOrigin}/payments/purincash/${order.purin_connection}`,
        customer: { externalId: `blackout:${base.accountId}:${order.id}` },
        metadata: JSON.stringify({
          accountId: base.accountId,
          orderId: order.id,
          subaccountId: order.purin_subaccount,
        }),
        subaccountId: order.purin_subaccount,
        ...(order.resale ? { subaccountFeeCents: order.resale.baseCents } : {}),
      });
    } catch (error) {
      await botTransaction(this.store, async (tx) => {
        const attempt = await tx.get(attemptPath(base.accountId, order.id));
        if (!attempt || attempt.claim !== claim || attempt.payment_id) return;
        const definitive = error instanceof PurinProviderError && error.definitiveRejection;
        tx.set(attemptPath(base.accountId, order.id), {
          ...attempt,
          state: definitive ? 'rejected' : 'uncertain',
          last_failure: error instanceof HttpError ? error.code : 'PURIN_UNAVAILABLE',
          ...(error instanceof PurinProviderError ? { provider_status: error.providerStatus } : {}),
          failed_at: this.now(),
        });
      });
      throw error;
    }
    chargeId.parse(payment.paymentId);
    if (
      payment.environment !== 'live' ||
      payment.currency !== 'BRL' ||
      payment.amountCents !== order.total ||
      (payment.subaccountId && payment.subaccountId !== order.purin_subaccount)
    )
      throw new HttpError(409, 'PURIN_PAYMENT_MISMATCH', 'Cobrança não corresponde ao pedido.');
    const code = z.string().min(1).max(4000).parse(payment.pix?.brCode);
    // Render locally from BR Code. Never fetch provider-supplied image URLs (SSRF/tracking).
    const encoded =
      typeof payment.pix?.qrCodeImage === 'string'
        ? /^data:image\/png;base64,([A-Za-z0-9+/=]{1,400000})$/.exec(payment.pix.qrCodeImage)?.[1]
        : '';
    const image = encoded ?? '';
    await botTransaction(this.store, async (tx) => {
      const savedOrder = (await tx.get(botPath(base.accountId, 'orders', order.id))) as Order;
      const attempt = await tx.get(attemptPath(base.accountId, order.id));
      if (
        !attempt ||
        (savedOrder.purin_payment_id && savedOrder.purin_payment_id !== payment.paymentId)
      )
        throw uncertain();
      tx.set(botPath(base.accountId, 'orders', order.id), {
        ...savedOrder,
        purin_payment_id: payment.paymentId,
      });
      tx.set(attemptPath(base.accountId, order.id), {
        ...attempt,
        state: 'created',
        payment_id: payment.paymentId,
        live: true,
        qr_ciphertext: this.vault.seal(
          JSON.stringify({ code, image }),
          `purin-qr:${base.accountId}:${order.id}`,
        ),
      });
    });
    return this.details(base);
  }
  private async reconcile(id: string, order: Order, token: string) {
    const list = await this.provider(
      token,
      '/charges?limit=100&subaccountId=' + subaccountId.parse(order.purin_subaccount),
    );
    const found = list.charges?.filter(
      (p: Doc) => p.customer?.externalId === `blackout:${id}:${order.id}`,
    );
    if (found?.length !== 1) throw uncertain();
    await this.confirm(
      id,
      order.id,
      order.purin_connection!,
      token,
      chargeId.parse(found[0].paymentId),
    );
  }
  async checkFromBot(id: string, buyer: string, oid: string) {
    if (!/^[a-f0-9]{16}$/.test(oid)) return;
    const order = (await this.store.get(botPath(id, 'orders', oid))) as Order | null;
    if (!order || order.buyer_id !== buyer || order.payment_method !== 'purincash') return;
    const c = await this.credentials(order.purin_connection!);
    if (order.purin_payment_id)
      await this.confirm(id, oid, order.purin_connection!, c.token, order.purin_payment_id);
    else {
      const attempt = await this.store.get(attemptPath(id, oid));
      if (
        !attempt ||
        attempt.state === 'rejected' ||
        (attempt.state === 'creating' &&
          this.now().getTime() - attempt.started_at.getTime() < 60000)
      )
        return;
      await this.reconcile(id, order, c.token);
    }
  }
  async refresh(raw: unknown) {
    const base = checkoutInput.parse(raw),
      order = await botTransaction(this.store, (tx) => this.checkout(tx, base));
    await this.checkFromBot(base.accountId, order.buyer_id, order.id);
    return this.details(base);
  }
  async notify(generation: string, raw: Buffer, signature: string, webhookId: string) {
    const c = await this.credentials(z.uuid().parse(generation));
    if (!validPurinSignature(raw, signature, c.secret))
      throw new HttpError(401, 'PURIN_SIGNATURE_INVALID', 'Notificação inválida.');
    let event: Doc;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Notificação inválida.');
    }
    if (event.event !== 'charge.paid') return;
    const paymentId = chargeId.parse(event.paymentId);
    if (webhookId !== 'charge.paid:' + paymentId || event.sandbox === true)
      throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Notificação inválida.');
    // Query trusted provider state, never deliver from webhook claims alone.
    const payment = await this.provider(c.token, '/charges/' + paymentId);
    let meta: Doc;
    try {
      meta = JSON.parse(payment.metadata);
    } catch {
      throw missing();
    }
    const base = z
      .object({ accountId: z.uuid(), orderId: z.string().regex(/^[a-f0-9]{16}$/), subaccountId })
      .strict()
      .parse(meta);
    await this.settle(base.accountId, base.orderId, generation, payment);
  }
  private async confirm(
    id: string,
    oid: string,
    generation: string,
    token: string,
    paymentId: string,
  ) {
    await this.settle(
      id,
      oid,
      generation,
      await this.provider(token, '/charges/' + chargeId.parse(paymentId)),
    );
  }
  async reconcileResale(accountId: string, oid: string) {
    const order = await this.store.get(botPath(accountId, 'orders', oid));
    if (!order?.resale) return true;
    await this.checkFromBot(accountId, order.buyer_id, oid);
    const current = await this.store.get(botPath(accountId, 'orders', oid));
    return [
      'delivered',
      'paid',
      'cancelled',
      'expired',
      'rejected',
      'refunded',
      'refund_required',
    ].includes(current?.status);
  }
  private async settle(id: string, oid: string, generation: string, payment: Doc) {
    let meta: Doc;
    try {
      meta = JSON.parse(payment.metadata);
    } catch {
      throw missing();
    }
    chargeId.parse(payment.paymentId);
    const snapshot = await this.store.get(botPath(id, 'orders', oid));
    let proof: Doc | null = null;
    if (snapshot?.resale && payment.status === 'paid') {
      const gateway = await this.subscriptionGateway(generation);
      proof = creditProof(
        snapshot.resale,
        payment,
        await gateway.ledger(snapshot.resale.subaccount, payment.paidAt, payment.paymentId),
      );
    }
    await botTransaction(this.store, async (tx) => {
      const [raw, attempt, account, setup, saved] = await Promise.all([
        tx.get(botPath(id, 'orders', oid)),
        tx.get(attemptPath(id, oid)),
        tx.get('merchant_accounts/' + id),
        tx.get('merchant_bot_setup/' + id),
        tx.get(connectionPath(generation)),
      ]);
      const shop = (await tx.get(botRoot(id))) as Shop | null,
        order = raw as Order | null;
      if (
        !order ||
        !shop ||
        !attempt ||
        !saved ||
        order.payment_method !== 'purincash' ||
        order.purin_connection !== generation ||
        attempt.generation !== generation ||
        attempt.subaccount !== order.purin_subaccount ||
        meta.accountId !== id ||
        meta.orderId !== oid ||
        meta.subaccountId !== order.purin_subaccount ||
        payment.currency !== 'BRL' ||
        payment.amountCents !== order.total ||
        (payment.environment !== undefined && payment.environment !== 'live') ||
        payment.sandbox === true ||
        (payment.subaccountId !== undefined && payment.subaccountId !== order.purin_subaccount) ||
        (order.resale &&
          payment.subaccountFeeCents !== undefined &&
          payment.subaccountFeeCents !== order.resale.baseCents) ||
        (order.purin_payment_id && order.purin_payment_id !== payment.paymentId) ||
        payment.customer?.externalId !== `blackout:${id}:${oid}`
      )
        throw new HttpError(
          409,
          'PURIN_PAYMENT_MISMATCH',
          'Valor, loja ou subconta não corresponde ao pedido.',
        );
      order.purin_payment_id = payment.paymentId;
      const release = async () => {
        if (order.status !== 'awaiting_payment') return;
        for (const item of order.items) {
          if (item.resale_source) {
            await restoreShared(tx, item);
            continue;
          }
          const stock = await tx.get(botPath(id, 'products', item.product_id));
          if (!stock) continue;
          restoreStock(stock, item);
          const product = shop.products.find((p) => p.id === item.product_id);
          if (product) syncStock(product, stock);
          tx.set(botPath(id, 'products', item.product_id), stock);
        }
        if (order.coupon && shop.coupons[order.coupon])
          shop.coupons[order.coupon].used = Math.max(0, shop.coupons[order.coupon].used - 1);
        shop.open_orders = shop.open_orders.filter((v) => v !== oid);
      };
      let index = 0;
      const emit = (method: 'sendMessage' | 'sendDocument', payload: Doc, delivery = false) => {
        const key = `purin_${oid}_${index++}`;
        tx.set(botPath(id, 'effects', key), {
          id: key,
          method,
          status: 'pending',
          order_id: oid,
          ...(delivery ? { delivery: true } : {}),
          payload_ciphertext: this.vault.seal(JSON.stringify(payload), `${id}:effect:${key}`),
          created_at: this.now(),
        });
        return key;
      };
      if (payment.status === 'refunded') {
        await release();
        order.status = 'refunded';
      } else if (payment.status === 'expired' && order.status === 'awaiting_payment') {
        await release();
        order.status = 'expired';
      } else if (
        order.resale &&
        payment.status === 'paid' &&
        !proof &&
        order.status === 'awaiting_payment'
      ) {
        // Keep the reservation until the provider ledger confirms the allocation.
      } else if (
        order.resale &&
        payment.status === 'paid' &&
        proof?.status !== 'credited' &&
        order.status === 'awaiting_payment'
      ) {
        await release();
        order.status = 'refund_required';
        if (proof) await recordCommission(tx, proof, { accountId: id, orderId: oid }, this.now());
      } else if (
        payment.status === 'paid' &&
        !['paid', 'delivered', 'refunded', 'refund_required', 'refund_pending'].includes(
          order.status,
        )
      ) {
        if (
          order.status !== 'awaiting_payment' ||
          order.expires_at <= this.now() ||
          account?.access_status !== 'approved' ||
          setup?.activation_status !== 'active' ||
          account.paid_through <= this.now()
        ) {
          await release();
          order.status = 'refund_required';
          emit('sendMessage', {
            chat_id: shop.owner_id,
            text: `Pix recebido para pedido encerrado ${oid}. Confira a PurinCash e providencie atendimento/reembolso. Entrega bloqueada.`,
          });
        } else {
          if (proof) await recordCommission(tx, proof, { accountId: id, orderId: oid }, this.now());
          for (const item of order.items) if (item.resale_source) await finishShared(tx, item);
          order.status = 'paid';
          order.charge_id = 'purin:' + payment.paymentId;
          await recordPaid(tx, id, shop, order, this.now());
          shop.open_orders = shop.open_orders.filter((v) => v !== oid);
          emit('sendMessage', {
            chat_id: order.buyer_id,
            text: `✅ PAGAMENTO CONFIRMADO\n\nPedido #${oid}\nRecebemos seu Pix de ${money(order.total, 'BRL')}.\n\n🎁 Seus produtos estão chegando abaixo.\nVocê também pode consultar tudo em Meus pedidos.`,
          });
          order.delivery_effects = [];
          for (const item of order.items)
            for (const unit of item.units) {
              const content = JSON.parse(
                this.vault.open(unit.ciphertext, `${id}:stock:${item.product_id}:${unit.id}`),
              );
              order.delivery_effects.push(
                emit(
                  content.kind === 'document' ? 'sendDocument' : 'sendMessage',
                  {
                    chat_id: order.buyer_id,
                    ...(content.kind === 'document'
                      ? { document: content.fileId, caption: `🎁 ${item.title}\nPedido #${oid}` }
                      : { text: `🎁 ${item.title}\n\n${content.text}\n\nPedido #${oid}` }),
                  },
                  true,
                ),
              );
            }
        }
        this.audit(tx, id, 'purincash', 'bot_order.automatic_pix_' + order.status);
      }
      tx.set(botPath(id, 'orders', oid), order);
      tx.set(botRoot(id), shop);
    });
    // Durable effects are claimed by the authenticated bot worker with its usual leases/acks.
  }
}
