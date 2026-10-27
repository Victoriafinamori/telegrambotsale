import { z } from 'zod';
import type { Doc, DocumentStore } from './document-store.js';
import { HttpError } from './types.js';
const iso = (value: unknown) =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const timestamp = (value: unknown) => (value instanceof Date ? value.getTime() : 0);
type Alert = {
  kind: 'connection' | 'payment' | 'delivery' | 'activation' | 'access';
  severity: 'attention' | 'waiting';
  title: string;
  detail: string;
  reference: string | null;
};
export class AdminHealth {
  constructor(
    private store: DocumentStore,
    private now = () => new Date(),
  ) {}
  async account(id: string) {
    z.uuid().parse(id);
    const row = await this.store.get('merchant_accounts/' + id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Loja não encontrada.');
    return Object.fromEntries(
      [
        'id',
        'name',
        'email',
        'store_name',
        'channel',
        'reference',
        'price_cents',
        'billing_months',
        'firebase_uid',
        'purchase_confirmed_at',
        'access_status',
        'created_at',
        'approved_at',
        'suspension_reason',
        'billing_started_at',
        'paid_through',
        'bot_username',
        'bot_activation_status',
        'bot_submitted_at',
      ].map((key) => [key, row[key] ?? null]),
    );
  }
  async read(raw: unknown) {
    const input = z
      .object({
        after: z
          .string()
          .max(36)
          .regex(/^$|^[a-f0-9-]{36}$/)
          .default(''),
      })
      .strict()
      .parse(raw);
    const accounts = await this.store.list('merchant_accounts', {
      limit: 11,
      afterId: input.after,
    });
    const hosting = await this.store.get('platform_hosting/hyze');
    const rows = await Promise.all(accounts.slice(0, 10).map((account) => this.row(account)));
    // Subscription checkout is separate from merchant sales. This is a recent
    // bounded sample, not a claim that older unresolved invoices do not exist.
    const invoices = await this.store.list('platform_subscription_invoices', {
      limit: 31,
      orderBy: 'created_at',
    });
    const billing = invoices
      .slice(0, 30)
      .filter(
        (invoice) =>
          ['creating', 'uncertain', 'review_required'].includes(invoice.status) ||
          (invoice.status === 'awaiting_payment' &&
            timestamp(invoice.expires_at) > this.now().getTime()),
      )
      .map((invoice) => ({
        id: String(invoice.id),
        accountId: typeof invoice.account_id === 'string' ? invoice.account_id : null,
        status: String(invoice.status),
        purpose: invoice.purpose === 'initial' ? 'Contratação' : 'Assinatura',
        amountCents: Number.isSafeInteger(invoice.total) ? invoice.total : null,
        createdAt: iso(invoice.created_at),
        expiresAt: iso(invoice.expires_at),
        attention:
          ['uncertain', 'review_required'].includes(invoice.status) ||
          (invoice.status === 'creating' &&
            this.now().getTime() - timestamp(invoice.created_at) > 120000),
      }));
    return {
      checkedAt: this.now().toISOString(),
      rows,
      next: accounts.length > 10 ? String(accounts[9].id) : null,
      hosting: {
        provider: 'Hyze Cloud',
        connected: Boolean(hosting?.ciphertext),
        enabled: hosting?.enabled === true,
      },
      billing,
      billingSampleLimited: invoices.length > 30,
      summary: {
        stores: rows.length,
        online: rows.filter((row) => row.connection === 'online').length,
        disconnected: rows.filter((row) =>
          ['offline', 'never_seen', 'revoked', 'mismatch'].includes(row.connection),
        ).length,
        needsAttention: rows.filter((row) =>
          row.alerts.some((alert) => alert.severity === 'attention'),
        ).length,
        activationPending: rows.filter((row) => row.activationPending).length,
        pendingPayments: rows.reduce((total, row) => total + row.counts.waitingPayment, 0),
        deliveryIssues: rows.reduce((total, row) => total + row.counts.deliveryIssues, 0),
      },
    };
  }
  private async row(account: Doc) {
    const id = String(account.id),
      base = 'bot_shops/' + id;
    const [setup, runtime, shop, job, recent, failed, uncertain, sending] = await Promise.all([
      this.store.get('merchant_bot_setup/' + id),
      this.store.get('bot_runtimes/' + id),
      this.store.get(base),
      this.store.get('bot_activation_jobs/' + id),
      this.store.list(base + '/orders', { limit: 26, orderBy: 'created_at' }),
      this.store.list(base + '/effects', { limit: 21, equals: ['status', 'failed'] }),
      this.store.list(base + '/effects', { limit: 21, equals: ['status', 'uncertain'] }),
      this.store.list(base + '/effects', { limit: 21, equals: ['status', 'sending'] }),
    ]);
    const openIds = [
      ...new Set<string>(
        Array.isArray(shop?.open_orders)
          ? shop.open_orders.filter(
              (value: unknown) => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value),
            )
          : [],
      ),
    ];
    const orderMap = new Map(recent.slice(0, 25).map((order) => [String(order.id), order]));
    const effectSample = [
      ...failed.slice(0, 20),
      ...uncertain.slice(0, 20),
      ...sending.slice(0, 20),
    ].filter(
      (effect) =>
        effect.delivery === true &&
        typeof effect.order_id === 'string' &&
        /^[a-f0-9]{16}$/.test(effect.order_id),
    );
    const missing = [
      ...new Set([...openIds.slice(0, 25), ...effectSample.map((effect) => effect.order_id)]),
    ].filter((orderId) => !orderMap.has(orderId));
    for (const order of await Promise.all(
      missing.map((orderId) => this.store.get(base + '/orders/' + orderId)),
    ))
      if (order) orderMap.set(String(order.id), order);
    const alerts: Alert[] = [];
    const add = (
      kind: Alert['kind'],
      severity: Alert['severity'],
      title: string,
      detail: string,
      reference: string | null = null,
    ) => {
      alerts.push({ kind, severity, title, detail, reference });
    };
    const connection = !runtime
      ? 'unconfigured'
      : runtime.revoked
        ? 'revoked'
        : runtime.bot_id !== setup?.bot_id
          ? 'mismatch'
          : !runtime.last_seen
            ? 'never_seen'
            : this.now().getTime() - timestamp(runtime.last_seen) < 90000
              ? 'online'
              : 'offline';
    const active = account.access_status === 'approved' && setup?.activation_status === 'active';
    if (active && connection !== 'online')
      add(
        'connection',
        'attention',
        'Bot sem conexão confirmada',
        connection === 'revoked'
          ? 'A credencial de execução foi revogada.'
          : connection === 'mismatch'
            ? 'O runtime não corresponde ao bot cadastrado.'
            : 'Não houve heartbeat válido nos últimos 90 segundos. Confira a hospedagem e a conexão com a API.',
      );
    if (account.access_status === 'suspended')
      add(
        'access',
        'waiting',
        'Acesso suspenso',
        'A suspensão está registrada. Confira a situação contratual antes de tratar como falha técnica.',
      );
    if (active && timestamp(account.paid_through) <= this.now().getTime())
      add(
        'access',
        'attention',
        'Assinatura vencida',
        'Novos pedidos ficam pausados até a renovação.',
      );
    const activationPending = Boolean(
      account.access_status === 'approved' &&
        setup?.submitted_at &&
        setup.activation_status !== 'active',
    );
    if (activationPending) {
      const exception =
        job && (['action_required', 'uncertain'].includes(job.stage) || job.provider !== 'hyze');
      const titles: Record<string, string> = {
        queued: 'Ativação na fila',
        checking: 'Validando ativação',
        uploading: 'Publicação em andamento',
        configuring: 'Conectando aplicativo',
        waiting_owner: 'Aguardando confirmação do responsável',
        action_required: 'Ativação precisa de intervenção',
        uncertain: 'Publicação em conferência',
      };
      add(
        'activation',
        exception || setup?.activation_status === 'changes_requested' ? 'attention' : 'waiting',
        job
          ? (titles[job.stage] ?? 'Conferir ativação')
          : setup?.activation_status === 'changes_requested'
            ? 'Correção de dados solicitada'
            : 'Aguardando preparação da hospedagem',
        job?.provider && job.provider !== 'hyze'
          ? 'Ativação do provedor anterior; exige migração explícita.'
          : job?.error_code
            ? 'Motivo: ' + String(job.error_code).slice(0, 80)
            : !job
              ? 'Ainda não existe uma publicação automática para esta loja.'
              : 'Acompanhe os detalhes na ficha da loja.',
      );
    }
    let waitingPayment = 0,
      paymentIssues = 0,
      manualReview = 0;
    const deliveryIds = new Set<string>();
    const orders = [...orderMap.values()];
    for (const order of orders) {
      const oid = String(order.id),
        expired =
          timestamp(order.expires_at) > 0 && timestamp(order.expires_at) <= this.now().getTime();
      if (order.status === 'awaiting_review') {
        manualReview++;
        add(
          'payment',
          'waiting',
          'Comprovante aguardando o lojista',
          'O pagamento manual precisa ser conferido pelo responsável da loja.',
          oid,
        );
      }
      if (['refund_required', 'refund_pending'].includes(order.status)) {
        paymentIssues++;
        add(
          'payment',
          'attention',
          'Pagamento em revisão ou reembolso',
          'Confira o pedido e o provedor; não gere uma nova cobrança para resolver este alerta.',
          oid,
        );
      }
      if (['awaiting_payment', 'precheckout'].includes(order.status)) {
        if (!expired) waitingPayment++;
        if (expired) {
          paymentIssues++;
          add(
            'payment',
            'attention',
            'Pedido aguardando encerramento',
            'O prazo local terminou e o registro ainda está aberto. Confira o bot e a confirmação do provedor.',
            oid,
          );
        } else if (['purincash', 'mercadopago'].includes(order.payment_method)) {
          const attempt = await this.store.get(
            `merchant_payment_secrets/${id}/${order.payment_method === 'purincash' ? 'purin_payments' : 'payments'}/${oid}`,
          );
          if (
            attempt &&
            !attempt.payment_id &&
            !order.purin_payment_id &&
            !order.mp_payment_id &&
            attempt.state !== 'rejected' &&
            this.now().getTime() - timestamp(order.created_at) > 120000
          ) {
            paymentIssues++;
            add(
              'payment',
              'attention',
              'Geração de cobrança em conferência',
              'Existe uma tentativa sem confirmação local de geração. Confira o pedido antes de repetir a cobrança.',
              oid,
            );
          }
        }
      }
      if (order.status === 'paid' && this.now().getTime() - timestamp(order.created_at) > 120000) {
        deliveryIds.add(oid);
        add(
          'delivery',
          'attention',
          'Pagamento aprovado, entrega pendente',
          'A entrega ainda não foi confirmada pelo worker. Não reenvie sem conferir o resultado anterior.',
          oid,
        );
      }
    }
    for (const effect of effectSample) {
      const order = orderMap.get(effect.order_id);
      if (!order || !['paid', 'delivered'].includes(order.status)) continue;
      if (effect.status === 'sending' && this.now().getTime() - timestamp(effect.lease_at) < 120000)
        continue;
      deliveryIds.add(effect.order_id);
      add(
        'delivery',
        'attention',
        effect.status === 'failed' ? 'Falha na entrega' : 'Entrega com resultado incerto',
        'O envio requer conferência. Reenviar automaticamente pode duplicar a entrega.',
        effect.order_id,
      );
    }
    const limited =
      recent.length > 25 ||
      openIds.length > 25 ||
      [failed, uncertain, sending].some((values) => values.length > 20);
    return {
      id,
      storeName: String(account.store_name ?? 'Loja'),
      botUsername: typeof setup?.bot_username === 'string' ? setup.bot_username : null,
      access: String(account.access_status),
      connection,
      lastSeen: iso(runtime?.last_seen),
      activation: setup?.activation_status ?? 'not_submitted',
      activationPending,
      jobStage: typeof job?.stage === 'string' ? job.stage : null,
      counts: { waitingPayment, paymentIssues, manualReview, deliveryIssues: deliveryIds.size },
      alerts: alerts.filter(
        (alert, index) =>
          alerts.findIndex(
            (other) => other.title === alert.title && other.reference === alert.reference,
          ) === index,
      ),
      limited,
    };
  }
}
