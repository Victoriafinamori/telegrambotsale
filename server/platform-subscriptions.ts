import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DocumentStore, Doc } from './document-store.js';
import { botTransaction, botPath } from './bot-data.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { nextBillingMonth } from './billing-period.js';
import { PurinCashPayments, PurinProviderError } from './purin-cash.js';

export const subscriptionPlans = [
  { id: 'monthly', label: 'Mensal', months: 1 },
  { id: 'quarterly', label: 'Trimestral', months: 3 },
  { id: 'annual', label: 'Anual', months: 12 },
] as const;
const planId = z.enum(['monthly', 'quarterly', 'annual']);
const settingsPath = 'platform_billing/settings';
const invoicePath = (id: string) => 'platform_subscription_invoices/' + z.uuid().parse(id);
const accountPath = (id: string) => 'merchant_accounts/' + id;
const clock = (date: unknown) => (date instanceof Date ? date.toISOString() : null);
export class PlatformSubscriptions {
  private vault: SecretVault;
  constructor(
    readonly store: DocumentStore,
    key: string,
    readonly purin: PurinCashPayments,
    readonly webOrigin: string,
    readonly apiOrigin: string,
    readonly now = () => new Date(),
  ) {
    this.vault = new SecretVault(key);
  }
  async settings() {
    const data = await this.store.get(settingsPath);
    return {
      revision: data?.revision ?? 0,
      plans: subscriptionPlans.map((p) => ({
        ...p,
        priceCents: data?.prices?.[p.id] ?? 0,
        enabled: Number.isInteger(data?.prices?.[p.id]) && data!.prices[p.id] > 0,
      })),
    };
  }
  async configure(actor: string, raw: unknown) {
    const price = z.number().int().min(1).max(10000000);
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        prices: z.object({ monthly: price, quarterly: price, annual: price }).strict(),
      })
      .strict()
      .parse(raw);
    await botTransaction(this.store, async (tx) => {
      const current = await tx.get(settingsPath);
      if ((current?.revision ?? 0) !== input.revision)
        throw new HttpError(409, 'PLANS_CHANGED', 'Os planos mudaram. Atualize a página.');
      tx.set(settingsPath, {
        prices: input.prices,
        revision: input.revision + 1,
        updated_at: this.now(),
        updated_by: actor,
      });
      tx.set('platform_billing_audit/' + randomUUID(), {
        action: 'plans.updated',
        actor,
        prices: input.prices,
        created_at: this.now(),
      });
    });
    return this.settings();
  }
  private async context(id: string, uid: string) {
    const account = await this.store.get(accountPath(id));
    if (!account || account.firebase_uid !== uid || account.access_status !== 'approved')
      throw new HttpError(
        403,
        'SUBSCRIPTION_OWNER_REQUIRED',
        'A assinatura é exclusiva do lojista responsável.',
      );
    const setup = await this.store.get('merchant_bot_setup/' + id);
    return { account, setup };
  }
  async assignInitial(id: string, actor: string, raw: unknown) {
    const input = z.object({ plan: planId }).strict().parse(raw),
      settings = await this.settings(),
      plan = settings.plans.find((p) => p.id === input.plan)!;
    if (!plan.enabled)
      throw new HttpError(409, 'PLAN_NOT_CONFIGURED', 'Configure os preços dos planos primeiro.');
    await botTransaction(this.store, async (tx) => {
      const a = await tx.get(accountPath(id));
      if (!a || a.billing_started_at)
        throw new HttpError(
          409,
          'ALREADY_ACTIVATED',
          'Este ciclo já começou. Para mudar de plano, use a renovação.',
        );
      tx.set(accountPath(id), { ...a, billing_months: plan.months, price_cents: plan.priceCents });
      tx.set('platform_billing_audit/' + randomUUID(), {
        action: 'initial_plan.assigned',
        actor,
        accountId: id,
        plan: plan.id,
        priceCents: plan.priceCents,
        created_at: this.now(),
      });
    });
    return { ok: true };
  }
  private safe(invoice: Doc) {
    let qrCode = '';
    if (
      invoice.qr_ciphertext &&
      invoice.status === 'awaiting_payment' &&
      invoice.expires_at > this.now()
    )
      qrCode = this.vault.open(invoice.qr_ciphertext, 'subscription-qr:' + invoice.id);
    return {
      id: invoice.id,
      plan: invoice.plan,
      label: invoice.label,
      months: invoice.months,
      total: invoice.total,
      status: invoice.status,
      expiresAt: clock(invoice.expires_at),
      paidThrough: clock(invoice.paid_through),
      qrCode,
    };
  }
  async read(id: string, uid: string) {
    const { account, setup } = await this.context(id, uid),
      active = await this.store.get('platform_subscription_accounts/' + id),
      invoice = active?.invoice_id ? await this.store.get(invoicePath(active.invoice_id)) : null;
    return {
      plans: (await this.settings()).plans,
      paidThrough: clock(account.paid_through),
      months: account.billing_months ?? 1,
      canRenew: Boolean(account.billing_started_at && setup?.activation_status === 'active'),
      invoice: invoice ? this.safe(invoice) : null,
    };
  }
  async create(id: string, uid: string, raw: unknown) {
    const input = z
        .object({
          plan: planId,
          requestId: z.uuid(),
          expectedPriceCents: z.number().int().positive().optional(),
        })
        .strict()
        .parse(raw),
      { account, setup } = await this.context(id, uid);
    if (!account.billing_started_at || setup?.activation_status !== 'active')
      throw new HttpError(
        409,
        'BOT_NOT_ACTIVATED',
        'A renovação fica disponível após a ativação. A Blackout configura o plano inicial da contratação.',
      );
    const plan = (await this.settings()).plans.find((p) => p.id === input.plan)!;
    if (!plan.enabled)
      throw new HttpError(409, 'PLAN_NOT_CONFIGURED', 'Este plano ainda não está disponível.');
    const gateway = await this.purin.subscriptionGateway(),
      invoiceId = randomUUID();
    if (input.expectedPriceCents !== undefined && input.expectedPriceCents !== plan.priceCents)
      throw new HttpError(
        409,
        'PLAN_PRICE_CHANGED',
        'O preço deste plano mudou. Atualize os planos antes de gerar o Pix.',
      );
    const claim = await botTransaction(this.store, async (tx) => {
      const a = await tx.get(accountPath(id));
      if (a?.firebase_uid !== uid || a.access_status !== 'approved')
        throw new HttpError(403, 'SUBSCRIPTION_OWNER_REQUIRED', 'Acesso indisponível.');
      const pointer = await tx.get('platform_subscription_accounts/' + id),
        previous = pointer?.invoice_id ? await tx.get(invoicePath(pointer.invoice_id)) : null;
      if (
        previous &&
        (['creating', 'uncertain'].includes(previous.status) ||
          (previous.status === 'awaiting_payment' && previous.expires_at > this.now()))
      )
        return { invoice: previous, created: false };
      const receipt = await tx.get('platform_subscription_requests/' + id + '_' + input.requestId);
      if (receipt)
        return { invoice: (await tx.get(invoicePath(receipt.invoice_id)))!, created: false };
      const invoice = {
        id: invoiceId,
        account_id: id,
        uid,
        plan: plan.id,
        label: plan.label,
        months: plan.months,
        total: plan.priceCents,
        generation: gateway.generation,
        status: 'creating',
        created_at: this.now(),
        expires_at: new Date(this.now().getTime() + 3600000),
        payment_id: null,
      };
      tx.set(invoicePath(invoiceId), invoice);
      tx.set('platform_subscription_accounts/' + id, { invoice_id: invoiceId });
      tx.set('platform_subscription_requests/' + id + '_' + input.requestId, {
        invoice_id: invoiceId,
      });
      return { invoice, created: true };
    });
    if (!claim.created) return this.safe(claim.invoice);
    const invoice = claim.invoice;
    let payment: Doc;
    try {
      payment = await gateway.create({
        valueCents: invoice.total,
        description: `Assinatura Blackout ${invoice.label} — ${invoice.id}`,
        expiresIn: 3600,
        callbackUrl: this.apiOrigin + '/payments/subscriptions/' + gateway.generation,
        customer: { externalId: 'blackout-subscription:' + invoice.id },
        metadata: JSON.stringify({
          kind: 'blackout_subscription',
          invoiceId: invoice.id,
          accountId: id,
        }),
      });
    } catch (e) {
      await botTransaction(this.store, async (tx) => {
        const current = await tx.get(invoicePath(invoice.id));
        if (current?.status === 'creating')
          tx.set(invoicePath(invoice.id), {
            ...current,
            status:
              e instanceof PurinProviderError && e.definitiveRejection ? 'failed' : 'uncertain',
            failure: e instanceof HttpError ? e.code : 'PROVIDER_UNAVAILABLE',
          });
      });
      throw e;
    }
    this.validate(invoice, payment);
    const code = z.string().min(1).max(4000).parse(payment.pix?.brCode);
    await botTransaction(this.store, async (tx) => {
      const current = await tx.get(invoicePath(invoice.id));
      if (!current) throw Error('Missing invoice');
      tx.set(invoicePath(invoice.id), {
        ...current,
        payment_id: payment.paymentId,
        ...(['paid', 'review_required'].includes(current.status)
          ? {}
          : {
              status: 'awaiting_payment',
              qr_ciphertext: this.vault.seal(code, 'subscription-qr:' + invoice.id),
            }),
      });
    });
    if (payment.status === 'paid') await this.settle(invoice.id, gateway.generation, payment);
    return this.safe((await this.store.get(invoicePath(invoice.id)))!);
  }
  private validate(invoice: Doc, payment: Doc) {
    let meta: Doc;
    try {
      meta = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;
    } catch {
      throw new HttpError(409, 'SUBSCRIPTION_MISMATCH', 'Cobrança não corresponde à assinatura.');
    }
    if (
      !/^psc_[A-Za-z0-9_-]+$/.test(payment.paymentId ?? '') ||
      payment.environment !== 'live' ||
      payment.currency !== 'BRL' ||
      payment.amountCents !== invoice.total ||
      payment.subaccountId ||
      meta?.kind !== 'blackout_subscription' ||
      meta?.invoiceId !== invoice.id ||
      meta?.accountId !== invoice.account_id ||
      (invoice.payment_id && invoice.payment_id !== payment.paymentId)
    )
      throw new HttpError(409, 'SUBSCRIPTION_MISMATCH', 'Cobrança não corresponde à assinatura.');
  }
  async check(id: string, uid: string, raw: unknown) {
    const { invoiceId } = z.object({ invoiceId: z.uuid() }).strict().parse(raw);
    await this.context(id, uid);
    let invoice = await this.store.get(invoicePath(invoiceId));
    if (!invoice || invoice.account_id !== id || invoice.uid !== uid)
      throw new HttpError(404, 'INVOICE_NOT_FOUND', 'Cobrança não encontrada.');
    if (['paid', 'review_required', 'failed'].includes(invoice.status)) return this.safe(invoice);
    const gateway = await this.purin.subscriptionGateway(invoice.generation);
    let payment: Doc | undefined;
    if (invoice.payment_id) payment = await gateway.read(invoice.payment_id);
    else {
      const list = await gateway.list(),
        found = (list.charges ?? []).filter(
          (p: Doc) => p.customer?.externalId === 'blackout-subscription:' + invoiceId,
        );
      if (found.length === 1) payment = await gateway.read(found[0].paymentId);
      if (found.length > 1)
        throw new HttpError(
          409,
          'SUBSCRIPTION_REVIEW',
          'Há mais de uma cobrança para conferir. Fale com a Blackout.',
        );
    }
    if (payment) {
      this.validate(invoice, payment);
      await this.settle(invoiceId, invoice.generation, payment);
      if (payment.pix?.brCode)
        await botTransaction(this.store, async (tx) => {
          const current = await tx.get(invoicePath(invoiceId));
          if (current?.status === 'awaiting_payment')
            tx.set(invoicePath(invoiceId), {
              ...current,
              qr_ciphertext: this.vault.seal(
                z.string().min(1).max(4000).parse(payment!.pix.brCode),
                'subscription-qr:' + invoiceId,
              ),
            });
        });
    }
    invoice = (await this.store.get(invoicePath(invoiceId)))!;
    return this.safe(invoice);
  }
  async notify(generation: string, raw: Buffer, signature: string, webhookId: string) {
    const gateway = await this.purin.subscriptionGateway(z.uuid().parse(generation));
    if (!gateway.verify(raw, signature))
      throw new HttpError(401, 'PURIN_SIGNATURE_INVALID', 'Notificação inválida.');
    let event: Doc;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Notificação inválida.');
    }
    if (event.event !== 'charge.paid') return;
    if (event.sandbox === true || webhookId !== 'charge.paid:' + event.paymentId)
      throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Notificação inválida.');
    const payment = await gateway.read(event.paymentId);
    let meta: Doc;
    try {
      meta = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;
    } catch {
      throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Notificação inválida.');
    }
    if (meta?.kind !== 'blackout_subscription')
      throw new HttpError(400, 'PURIN_EVENT_INVALID', 'Notificação inválida.');
    await this.settle(z.uuid().parse(meta.invoiceId), generation, payment);
  }
  private async settle(invoiceId: string, generation: string, payment: Doc) {
    await botTransaction(this.store, async (tx) => {
      const invoice = await tx.get(invoicePath(invoiceId));
      if (!invoice || invoice.generation !== generation)
        throw new HttpError(404, 'INVOICE_NOT_FOUND', 'Cobrança não encontrada.');
      this.validate(invoice, payment);
      if (invoice.status === 'paid' || invoice.status === 'review_required') return;
      const a = await tx.get(accountPath(invoice.account_id)),
        setup = await tx.get('merchant_bot_setup/' + invoice.account_id),
        receipt = await tx.get('platform_subscription_payments/' + payment.paymentId),
        shop = await tx.get('bot_shops/' + invoice.account_id);
      if (receipt && receipt.invoice_id !== invoiceId)
        throw new HttpError(409, 'PAYMENT_ALREADY_USED', 'Pagamento já vinculado.');
      if (payment.status !== 'paid') {
        tx.set(invoicePath(invoiceId), {
          ...invoice,
          payment_id: payment.paymentId,
          status:
            payment.status === 'expired'
              ? 'expired'
              : invoice.status === 'uncertain' || invoice.status === 'creating'
                ? 'awaiting_payment'
                : invoice.status,
        });
        return;
      }
      const paidAt = payment.paidAt ? new Date(payment.paidAt) : this.now();
      const eligible =
        a &&
        a.firebase_uid === invoice.uid &&
        a.access_status === 'approved' &&
        setup?.activation_status === 'active' &&
        a.billing_started_at &&
        Number.isFinite(paidAt.getTime()) &&
        paidAt <= invoice.expires_at &&
        paidAt <= this.now() &&
        !receipt;
      if (!eligible) {
        tx.set(invoicePath(invoiceId), {
          ...invoice,
          payment_id: payment.paymentId,
          status: 'review_required',
        });
        return;
      }
      const base =
          a!.paid_through instanceof Date && a!.paid_through > this.now()
            ? a!.paid_through
            : this.now(),
        until = nextBillingMonth(base, invoice.months);
      tx.set(accountPath(invoice.account_id), {
        ...a,
        paid_through: until,
        billing_months: invoice.months,
        price_cents: invoice.total,
      });
      tx.set(invoicePath(invoiceId), {
        ...invoice,
        status: 'paid',
        payment_id: payment.paymentId,
        paid_at: this.now(),
        paid_through: until,
      });
      tx.set('platform_subscription_payments/' + payment.paymentId, {
        invoice_id: invoiceId,
        account_id: invoice.account_id,
        months: invoice.months,
        total: invoice.total,
        paid_through: until,
        created_at: this.now(),
      });
      tx.set('platform_billing_audit/' + invoiceId, {
        action: 'subscription.renewed',
        account_id: invoice.account_id,
        invoice_id: invoiceId,
        months: invoice.months,
        total: invoice.total,
        created_at: this.now(),
      });
      if (
        shop?.owner_id &&
        shop.owner_id === setup!.telegram_user_id &&
        shop.owner_bot_id === setup!.bot_id
      ) {
        const eid = 'subscription_' + invoiceId.replaceAll('-', '');
        const payload = {
          chat_id: shop.owner_id,
          text: `Pagamento da assinatura Blackout confirmado. Plano ${invoice.label}: ${invoice.months} mês(es). Seu acesso está válido até ${until.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Minha assinatura', url: this.webOrigin + '/#/minha-loja?subscription=1' }],
            ],
          },
        };
        tx.set(botPath(invoice.account_id, 'effects', eid), {
          id: eid,
          method: 'sendMessage',
          status: 'pending',
          subscription_owner_id: shop.owner_id,
          created_at: this.now(),
          payload_ciphertext: this.vault.seal(
            JSON.stringify(payload),
            `${invoice.account_id}:effect:${eid}`,
          ),
        });
      }
    });
  }
}
