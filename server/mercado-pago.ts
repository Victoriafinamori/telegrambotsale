import { restoreStock, syncStock } from './stock-modes.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DocumentStore, DocumentTransaction, Doc } from './document-store.js';
import type { BotStore } from './bot-store.js';
import type { Shop, Order, BotEffect, TelegramMethod } from './bot-types.js';
import { botRoot, botPath, botTransaction } from './bot-data.js';
import { SecretVault } from './secret-vault.js';
import { tokenHash } from './accounts.js';
import { HttpError } from './types.js';
import { recordPaid } from './bot-orders.js';
import { pixKey, validDocument } from './pix.js';
import { TelegramClient, TelegramError } from './telegram-client.js';

const secretRoot = (id: string) => 'merchant_payment_secrets/' + id;
const connectionPath = (id: string, generation: string) =>
  secretRoot(id) + '/connections/' + generation;
const attemptPath = (id: string, oid: string) => secretRoot(id) + '/payments/' + oid;
const invalid = () =>
  new HttpError(
    404,
    'CHECKOUT_NOT_FOUND',
    'Link de pagamento inválido ou indisponível. Abra o pedido no Telegram.',
  );
const credentialsInput = z
  .object({
    accessToken: z
      .string()
      .trim()
      .min(20)
      .max(1024)
      .regex(/^[A-Za-z0-9_.-]+$/),
    webhookSecret: z
      .string()
      .trim()
      .min(16)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const checkoutInput = z
  .object({
    accountId: z.uuid(),
    orderId: z.string().regex(/^[a-f0-9]{16}$/),
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const payerInput = z
  .object({
    email: z.email().trim().toLowerCase().max(254),
    documentType: z.enum(['CPF', 'CNPJ']),
    document: z.string().trim().max(20),
  })
  .strict()
  .superRefine((payer, ctx) => {
    if (!validDocument(payer.document, payer.documentType === 'CPF' ? 'cpf' : 'cnpj'))
      ctx.addIssue({ code: 'custom', path: ['document'], message: 'CPF/CNPJ inválido.' });
  });
export function validMpSignature(
  signature: string,
  requestId: string,
  paymentId: string,
  secret: string,
  now: Date,
) {
  if (!/^\d{1,30}$/.test(paymentId) || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return false;
  const ts = /(?:^|,)\s*ts=(\d{10,13})(?:,|$)/.exec(signature)?.[1];
  const hashes = [...signature.matchAll(/(?:^|,)\s*v1=([a-f0-9]{64})(?=,|$)/g)].map((v) => v[1]);
  if (!ts || Math.abs(now.getTime() - Number(ts) * (ts.length === 10 ? 1000 : 1)) > 300000)
    return false;
  const digest = createHmac('sha256', secret)
    .update(`id:${paymentId};request-id:${requestId};ts:${ts};`)
    .digest();
  return hashes.some((hash) => timingSafeEqual(digest, Buffer.from(hash, 'hex')));
}

export class MercadoPagoPayments {
  private vault: SecretVault;
  constructor(
    readonly store: DocumentStore,
    key: string,
    readonly bots: BotStore,
    readonly webOrigin: string,
    readonly apiOrigin: string,
    private request: typeof fetch = fetch,
    readonly now: () => Date = () => new Date(),
    private liveEnabled = true,
  ) {
    this.vault = new SecretVault(key);
    for (const origin of [webOrigin, apiOrigin]) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        (url.protocol !== 'https:' && url.hostname !== '127.0.0.1')
      )
        throw Error('Invalid payment origin');
    }
    bots.checkoutOrigin = webOrigin;
  }
  private async provider(
    token: string,
    path: string,
    body?: unknown,
    idempotency?: string,
  ): Promise<Doc> {
    if (!this.liveEnabled)
      throw new HttpError(
        503,
        'PAYMENT_DEMO_ONLY',
        'Pagamentos reais ficam desativados em projetos demo e emuladores.',
      );
    let response: Response;
    try {
      response = await this.request('https://api.mercadopago.com' + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotency! }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new HttpError(
        502,
        'MP_UNAVAILABLE',
        'Mercado Pago indisponível. Tente novamente; a mesma cobrança será reutilizada.',
      );
    }
    if (!response.ok)
      throw new HttpError(
        502,
        'MP_REJECTED',
        [401, 403].includes(response.status)
          ? 'Mercado Pago recusou a credencial. Confira o Access Token no painel da loja.'
          : 'Mercado Pago não concluiu a solicitação. Confira os dados e a habilitação do Pix na conta.',
      );
    const text = await response.text();
    if (text.length > 2000000)
      throw new HttpError(502, 'MP_RESPONSE_INVALID', 'Resposta de pagamento indisponível.');
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, 'MP_RESPONSE_INVALID', 'Resposta de pagamento indisponível.');
    }
  }
  private async owner(tx: DocumentTransaction, id: string, uid: string) {
    const [account, shop] = await Promise.all([
      tx.get('merchant_accounts/' + id),
      tx.get(botRoot(id)),
    ]);
    if (!account || account.firebase_uid !== uid || account.access_status !== 'approved' || !shop)
      throw new HttpError(403, 'STORE_NOT_APPROVED', 'Sua loja não está liberada.');
    return shop as Shop;
  }
  private revision(shop: Shop, revision: number) {
    if ((shop.portal_revision ?? 0) !== revision)
      throw new HttpError(409, 'STORE_CHANGED', 'A loja mudou. Atualize o painel antes de salvar.');
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
  private webhookUrl(id: string, connection: string) {
    return `${this.apiOrigin}/payments/mercadopago/${id}/${connection}`;
  }
  async settings(id: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      const shop = await this.owner(tx, id, uid);
      const connection = shop.mp_connection
        ? await tx.get(connectionPath(id, shop.mp_connection))
        : null;
      return {
        mode: shop.payment_mode === 'stars' ? 'stars' : (shop.pix_mode ?? 'manual'),
        keys: shop.pix_keys ?? [],
        instructions: shop.payment_instructions ?? '',
        revision: shop.portal_revision ?? 0,
        connected: Boolean(connection),
        purinConnected: Boolean(shop.purin_connection && shop.purin_subaccount),
        purinRequested: shop.purin_requested === true,
        merchantName: connection?.merchant_name ?? '',
        merchantId: connection?.merchant_id ?? '',
        webhookUrl: `${this.apiOrigin}/payments/mercadopago/${id}/current`,
      };
    });
  }
  async connect(id: string, uid: string, input: unknown) {
    const value = credentialsInput.parse(input);
    await botTransaction(this.store, async (tx) =>
      this.revision(await this.owner(tx, id, uid), value.revision),
    );
    const user = await this.provider(value.accessToken, '/users/me');
    if (!/^\d{1,30}$/.test(String(user.id)) || user.site_id !== 'MLB')
      throw new HttpError(400, 'MP_ACCOUNT_INVALID', 'Conecte uma conta Mercado Pago do Brasil.');
    if (value.accessToken.startsWith('TEST-') || user.tags?.includes('test_user'))
      throw new HttpError(
        400,
        'MP_TEST_ACCOUNT',
        'Use credenciais de produção para a loja real. Contas de teste não liberam estoque real.',
      );
    await botTransaction(this.store, async (tx) => {
      const shop = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      const generation = randomUUID();
      tx.set(connectionPath(id, generation), {
        merchant_id: String(user.id),
        merchant_name: String(user.nickname ?? user.first_name ?? 'Conta conectada').slice(0, 100),
        ciphertext: this.vault.seal(
          JSON.stringify({ token: value.accessToken, secret: value.webhookSecret }),
          `mp:${id}:${generation}`,
        ),
        created_at: this.now(),
      });
      tx.set(botRoot(id), {
        ...shop,
        mp_connection: generation,
        portal_revision: value.revision + 1,
      });
      this.audit(tx, id, uid, 'store.mercadopago_connected');
    });
    return this.settings(id, uid);
  }
  async saveSettings(id: string, uid: string, input: unknown) {
    const parsed = z
      .object({
        mode: z.enum(['manual', 'mercadopago', 'purincash', 'stars']),
        keys: z.array(pixKey).max(3),
        instructions: z.string().trim().max(1000),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new HttpError(
        400,
        'PIX_SETTINGS_INVALID',
        parsed.error.issues.find((issue) => issue.message.startsWith('Chave Pix'))?.message ??
          'Confira o tipo, o valor e o recebedor das chaves Pix.',
      );
    const value = parsed.data;
    await botTransaction(this.store, async (tx) => {
      const shop = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      if (value.mode === 'purincash' && (!shop.purin_connection || !shop.purin_subaccount))
        throw new HttpError(
          409,
          'PURIN_NOT_BOUND',
          'Solicite a ativação do Pix Blackout. A equipe precisa vincular sua subconta.',
        );
      if (
        value.mode === 'mercadopago' &&
        (!shop.mp_connection || !(await tx.get(connectionPath(id, shop.mp_connection))))
      )
        throw new HttpError(
          409,
          'MP_NOT_CONNECTED',
          'Conecte sua conta Mercado Pago antes de ativar o Pix automático.',
        );
      if (shop.payment_mode === 'stars' && value.mode !== 'stars' && shop.products.length)
        throw new HttpError(
          409,
          'CURRENCY_CHANGE_REQUIRED',
          'Revise os preços em reais antes de trocar uma loja em Stars para Pix. Solicite a migração à equipe.',
        );
      if (shop.payment_mode !== 'stars' && value.mode === 'stars' && shop.products.length)
        throw new HttpError(
          409,
          'CURRENCY_CHANGE_REQUIRED',
          'Revise os preços em Stars antes de trocar uma loja em reais. Solicite a migração à equipe.',
        );
      tx.set(botRoot(id), {
        ...shop,
        payment_mode: value.mode === 'stars' ? 'stars' : 'manual',
        pix_mode:
          value.mode === 'mercadopago' || value.mode === 'purincash' ? value.mode : 'manual',
        pix_keys: value.keys,
        payment_instructions: value.instructions,
        portal_revision: value.revision + 1,
      });
      this.audit(tx, id, uid, 'store.payment_options_saved');
    });
  }
  private async checkout(tx: DocumentTransaction, input: z.infer<typeof checkoutInput>) {
    const order = (await tx.get(botPath(input.accountId, 'orders', input.orderId))) as Order | null;
    if (
      !order ||
      order.payment_method !== 'mercadopago' ||
      !/^[a-f0-9]{64}$/.test(order.checkout_token_hash ?? '') ||
      !timingSafeEqual(Buffer.from(tokenHash(input.key)), Buffer.from(order.checkout_token_hash!))
    )
      throw invalid();
    return order;
  }
  async details(raw: unknown) {
    const input = checkoutInput.parse(raw);
    return botTransaction(this.store, async (tx) => {
      const order = await this.checkout(tx, input),
        shop = await tx.get(botRoot(input.accountId));
      const attempt = await tx.get(attemptPath(input.accountId, input.orderId));
      const open = order.status === 'awaiting_payment' && order.expires_at > this.now();
      const charge =
        open && attempt?.charge_ciphertext
          ? JSON.parse(
              this.vault.open(
                attempt.charge_ciphertext,
                `mp-charge:${input.accountId}:${input.orderId}`,
              ),
            )
          : {};
      return {
        title: shop?.title ?? 'Loja',
        orderId: order.id,
        total: order.total,
        items: order.items.map((i) => ({ title: i.title, quantity: i.quantity })),
        status: order.status,
        expiresAt: order.expires_at.toISOString(),
        open,
        qrCode: charge.code ?? '',
        qrBase64: charge.image ?? '',
      };
    });
  }
  async create(raw: unknown) {
    const { payer, ...base } = z
      .object({ ...checkoutInput.shape, payer: payerInput })
      .strict()
      .parse(raw);
    const prepared = await botTransaction(this.store, async (tx) => {
      const order = await this.checkout(tx, base);
      const [shop, account, setup, existing] = await Promise.all([
        tx.get(botRoot(base.accountId)),
        tx.get('merchant_accounts/' + base.accountId),
        tx.get('merchant_bot_setup/' + base.accountId),
        tx.get(attemptPath(base.accountId, order.id)),
      ]);
      if (order.status !== 'awaiting_payment' || order.expires_at <= this.now())
        throw new HttpError(
          409,
          'ORDER_CLOSED',
          'Pedido encerrado ou vencido. Consulte o Telegram.',
        );
      if (
        account?.access_status !== 'approved' ||
        setup?.activation_status !== 'active' ||
        account.paid_through <= this.now() ||
        !shop
      )
        throw invalid();
      const connection = order.mp_connection!;
      const saved = await tx.get(connectionPath(base.accountId, connection));
      if (!saved) throw invalid();
      if (!existing) {
        order.expires_at = new Date(this.now().getTime() + 3600000);
        tx.set(botPath(base.accountId, 'orders', order.id), order);
      }
      const credentials = JSON.parse(
        this.vault.open(saved.ciphertext, `mp:${base.accountId}:${connection}`),
      );
      const payload = existing
        ? JSON.parse(
            this.vault.open(existing.payer_ciphertext, `mp-payer:${base.accountId}:${order.id}`),
          )
        : {
            transaction_amount: order.total / 100,
            description: `Pedido ${order.id} · ${shop.title}`.slice(0, 160),
            payment_method_id: 'pix',
            payer: {
              email: payer.email,
              identification: {
                type: payer.documentType,
                number: payer.document.replace(/\D/g, ''),
              },
            },
            external_reference: `blackout:${base.accountId}:${order.id}`,
            metadata: { blackout_account: base.accountId, blackout_order: order.id },
            date_of_expiration: order.expires_at.toISOString().replace('Z', '+00:00'),
            notification_url: this.webhookUrl(base.accountId, connection),
          };
      if (!existing)
        tx.set(attemptPath(base.accountId, order.id), {
          connection,
          payer_ciphertext: this.vault.seal(
            JSON.stringify(payload),
            `mp-payer:${base.accountId}:${order.id}`,
          ),
          created_at: this.now(),
        });
      return {
        token: credentials.token as string,
        payload,
        connection,
        existingId: order.mp_payment_id,
      };
    });
    const payment = prepared.existingId
      ? await this.provider(prepared.token, '/v1/payments/' + prepared.existingId)
      : await this.provider(
          prepared.token,
          '/v1/payments',
          prepared.payload,
          `blackout-${base.accountId}-${base.orderId}`,
        );
    const effects = await this.apply(base.accountId, prepared.connection, payment);
    await this.flush(base.accountId, effects);
    return this.details(base);
  }
  async notify(
    id: string,
    generation: string,
    paymentId: string,
    signature: string,
    requestId: string,
  ) {
    if (generation === 'current') {
      const shop = await this.store.get(botRoot(id));
      generation = shop?.mp_connection ?? '';
      if (!generation) throw new HttpError(401, 'MP_SIGNATURE_INVALID', 'Notificação inválida.');
    }
    const saved = await this.store.get(connectionPath(id, generation));
    if (!saved) throw new HttpError(401, 'MP_SIGNATURE_INVALID', 'Notificação inválida.');
    const credentials = JSON.parse(this.vault.open(saved.ciphertext, `mp:${id}:${generation}`));
    if (!validMpSignature(signature, requestId, paymentId, credentials.secret, this.now()))
      throw new HttpError(401, 'MP_SIGNATURE_INVALID', 'Notificação inválida.');
    const payment = await this.provider(credentials.token, '/v1/payments/' + paymentId);
    if (!String(payment.external_reference).startsWith(`blackout:${id}:`)) return;
    const effects = await this.apply(id, generation, payment);
    await this.flush(id, effects);
  }
  async checkFromBot(id: string, buyer: string, oid: string) {
    if (!/^[a-f0-9]{16}$/.test(oid)) return;
    const order = (await this.store.get(botPath(id, 'orders', oid))) as Order | null;
    if (
      !order ||
      order.buyer_id !== buyer ||
      order.payment_method !== 'mercadopago' ||
      !order.mp_payment_id
    )
      return;
    const saved = await this.store.get(connectionPath(id, order.mp_connection!));
    if (!saved) return;
    const credentials = JSON.parse(
      this.vault.open(saved.ciphertext, `mp:${id}:${order.mp_connection}`),
    );
    await this.flush(
      id,
      await this.apply(
        id,
        order.mp_connection!,
        await this.provider(credentials.token, '/v1/payments/' + order.mp_payment_id),
      ),
    );
  }
  async refresh(raw: unknown) {
    const input = checkoutInput.parse(raw);
    const order = await botTransaction(this.store, (tx) => this.checkout(tx, input));
    await this.checkFromBot(input.accountId, order.buyer_id, order.id);
    return this.details(input);
  }
  private async apply(id: string, connection: string, payment: Doc) {
    const reference = /^blackout:([0-9a-f-]{36}):([a-f0-9]{16})$/.exec(
      String(payment.external_reference),
    );
    if (!reference || reference[1] !== id || !/^\d{1,30}$/.test(String(payment.id)))
      throw new HttpError(409, 'MP_PAYMENT_MISMATCH', 'Pagamento não corresponde à loja.');
    const oid = reference[2];
    return botTransaction(this.store, async (tx) => {
      const [raw, attempt, saved, account, setup] = await Promise.all([
        tx.get(botPath(id, 'orders', oid)),
        tx.get(attemptPath(id, oid)),
        tx.get(connectionPath(id, connection)),
        tx.get('merchant_accounts/' + id),
        tx.get('merchant_bot_setup/' + id),
      ]);
      const order = raw as Order | null,
        shop = (await tx.get(botRoot(id))) as Shop | null;
      if (
        !order ||
        !attempt ||
        !saved ||
        !shop ||
        order.mp_connection !== connection ||
        attempt.connection !== connection ||
        order.payment_method !== 'mercadopago' ||
        String(payment.collector_id) !== saved.merchant_id ||
        payment.live_mode !== true ||
        payment.currency_id !== 'BRL' ||
        payment.payment_method_id !== 'pix' ||
        !Number.isFinite(payment.transaction_amount) ||
        Math.abs(payment.transaction_amount * 100 - order.total) > 0.000001 ||
        (order.mp_payment_id && order.mp_payment_id !== String(payment.id))
      )
        throw new HttpError(
          409,
          'MP_PAYMENT_MISMATCH',
          'Valor, recebedor ou pedido não corresponde à cobrança.',
        );
      const qr = payment.point_of_interaction?.transaction_data;
      if (
        qr?.qr_code &&
        typeof qr.qr_code === 'string' &&
        qr.qr_code.length <= 4000 &&
        typeof qr.qr_code_base64 === 'string' &&
        /^[A-Za-z0-9+/=]+$/.test(qr.qr_code_base64) &&
        qr.qr_code_base64.length <= 400000
      )
        tx.set(attemptPath(id, oid), {
          ...attempt,
          charge_ciphertext: this.vault.seal(
            JSON.stringify({ code: qr.qr_code, image: qr.qr_code_base64 }),
            `mp-charge:${id}:${oid}`,
          ),
        });
      const effects: string[] = [];
      const emit = (method: TelegramMethod, payload: Doc, delivery = false) => {
        const key = `mp_${oid}_${effects.length}`;
        tx.set(botPath(id, 'effects', key), {
          id: key,
          method,
          status: 'pending',
          order_id: oid,
          ...(delivery ? { delivery: true } : {}),
          payload_ciphertext: this.vault.seal(JSON.stringify(payload), `${id}:effect:${key}`),
          created_at: this.now(),
        });
        effects.push(key);
        return key;
      };
      order.mp_payment_id = String(payment.id);
      const releaseReservation = async () => {
        if (order.status !== 'awaiting_payment') return;
        for (const item of order.items) {
          const stock = await tx.get(botPath(id, 'products', item.product_id));
          if (!stock) continue;
          restoreStock(stock, item);
          const product = shop.products.find((p) => p.id === item.product_id);
          if (product) syncStock(product, stock);
          tx.set(botPath(id, 'products', item.product_id), stock);
        }
        if (order.coupon && shop.coupons[order.coupon])
          shop.coupons[order.coupon].used = Math.max(0, shop.coupons[order.coupon].used - 1);
        shop.open_orders = shop.open_orders.filter((value) => value !== oid);
      };
      const refundedAmount = Number(payment.transaction_amount_refunded ?? 0);
      if (['refunded', 'charged_back'].includes(payment.status) || refundedAmount > 0) {
        await releaseReservation();
        order.status =
          refundedAmount > 0 && refundedAmount < payment.transaction_amount
            ? 'refund_required'
            : 'refunded';
        this.audit(tx, id, 'mercadopago', 'bot_order.provider_reversal');
      } else if (
        ['cancelled', 'rejected'].includes(payment.status) &&
        order.status === 'awaiting_payment'
      ) {
        await releaseReservation();
        order.status = payment.status === 'rejected' ? 'rejected' : 'cancelled';
        this.audit(tx, id, 'mercadopago', 'bot_order.provider_cancelled');
      } else if (
        payment.status === 'approved' &&
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
          await releaseReservation();
          order.status = 'refund_required';
          this.audit(tx, id, 'mercadopago', 'bot_order.automatic_pix_needs_review');
          emit('sendMessage', {
            chat_id: shop.owner_id,
            text: `Pagamento Pix recebido para pedido encerrado ${oid}. Confira o Mercado Pago e providencie atendimento/reembolso. A entrega está bloqueada.`,
          });
        } else {
          order.status = 'paid';
          order.charge_id = 'mp:' + payment.id;
          await recordPaid(tx, id, shop, order, this.now());
          shop.open_orders = shop.open_orders.filter((value) => value !== oid);
          emit('sendMessage', {
            chat_id: order.buyer_id,
            text: `Pix confirmado pelo Mercado Pago. Pedido ${oid}. A entrega segue abaixo.`,
          });
          const delivery: string[] = [];
          for (const item of order.items)
            for (const unit of item.units) {
              const content = JSON.parse(
                this.vault.open(unit.ciphertext, `${id}:stock:${item.product_id}:${unit.id}`),
              );
              delivery.push(
                emit(
                  content.kind === 'document' ? 'sendDocument' : 'sendMessage',
                  {
                    chat_id: order.buyer_id,
                    ...(content.kind === 'document'
                      ? { document: content.fileId, caption: item.title }
                      : { text: `${item.title}\n\n${content.text}` }),
                  },
                  true,
                ),
              );
            }
          order.delivery_effects = delivery;
          this.audit(tx, id, 'mercadopago', 'bot_order.automatic_pix_confirmed');
        }
      }
      tx.set(botPath(id, 'orders', oid), order);
      tx.set(botRoot(id), shop);
      return effects;
    });
  }
  private async flush(id: string, ids: string[]) {
    if (!ids.length) return;
    try {
      const runtime = await this.store.get('bot_runtimes/' + id);
      if (!runtime) return;
      const auth = { accountId: id, generation: runtime.generation };
      const config = await this.bots.configuration(auth);
      const telegram = new TelegramClient(config.botToken, this.request);
      for (const eid of ids) {
        const effect = await this.bots.claim(auth, eid);
        if (!effect) continue;
        let result: 'sent' | 'uncertain' | 'failed' | 'retry' = 'sent',
          errorCode: number | undefined,
          retryAfter = 0;
        try {
          await telegram.call(effect.method, effect.payload);
        } catch (error) {
          errorCode = error instanceof TelegramError ? error.code : 0;
          result =
            errorCode === 429
              ? 'retry'
              : errorCode >= 400 && errorCode < 500
                ? 'failed'
                : 'uncertain';
          retryAfter = error instanceof TelegramError ? error.retryAfter : 0;
        }
        await this.bots.acknowledge(auth, eid, effect.lease, result, errorCode, retryAfter);
        if (result === 'retry') break;
      }
    } catch {
      /* Pending effects remain available to the authenticated bot worker; ambiguous sends keep their lease. */
    }
  }
}
