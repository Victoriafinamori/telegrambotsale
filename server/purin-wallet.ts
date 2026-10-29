import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import type { RuntimeAccess, TelegramUpdate } from './bot-types.js';
import { botPath, botRoot, botTransaction, botButtons } from './bot-data.js';
import { SecretVault } from './secret-vault.js';
import { pixKey, pixTypes } from './pix.js';
import { HttpError } from './types.js';
import { tokenHash } from './accounts.js';
import { saleBreakdown, payoutBreakdown } from './wallet-breakdown.js';

type Actor = { uid: string } | { telegram: string; auth: RuntimeAccess };
export type WalletScreen = {
  text: string;
  markup: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
};
const platform = 'platform_payments/purincash';
const rowPath = (id: string, wid: string) => `merchant_wallets/${id}/withdrawals/${wid}`;
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const back = () =>
  botButtons([
    [
      ['Carteira', 'admin:wallet'],
      ['Voltar', 'admin'],
    ],
  ]);
class ProviderFailure extends Error {
  constructor(
    readonly status: number,
    readonly minimum?: number,
  ) {
    super('Purin wallet request failed');
  }
}
export class PurinWallet {
  private vault: SecretVault;
  constructor(
    readonly store: DocumentStore,
    key: string,
    readonly webOrigin: string,
    private request: typeof fetch = fetch,
    readonly now = () => new Date(),
    private liveEnabled = true,
  ) {
    this.vault = new SecretVault(key);
  }
  private async context(id: string, actor: Actor) {
    return botTransaction(this.store, async (tx) => {
      const [account, shop, setup, settings] = await Promise.all([
        tx.get('merchant_accounts/' + id),
        tx.get(botRoot(id)),
        tx.get('merchant_bot_setup/' + id),
        tx.get(platform),
      ]);
      if (
        !account ||
        !shop ||
        !setup ||
        account.access_status !== 'approved' ||
        !shop.owner_id ||
        shop.owner_id !== setup.telegram_user_id ||
        shop.owner_bot_id !== setup.bot_id
      )
        throw new HttpError(
          403,
          'WALLET_OWNER_REQUIRED',
          'Carteira disponível somente ao responsável confirmado da loja.',
        );
      if ('uid' in actor) {
        if (account.firebase_uid !== actor.uid)
          throw new HttpError(403, 'WALLET_OWNER_REQUIRED', 'Carteira indisponível.');
      } else {
        const runtime = await tx.get('bot_runtimes/' + id);
        if (
          actor.auth.accountId !== id ||
          runtime?.generation !== actor.auth.generation ||
          actor.telegram !== shop.owner_id
        )
          throw new HttpError(403, 'WALLET_OWNER_REQUIRED', 'Carteira exclusiva do lojista.');
      }
      if (
        !shop.purin_connection ||
        !/^sacc_[A-Za-z0-9_-]{1,120}$/.test(shop.purin_subaccount ?? '')
      )
        throw new HttpError(
          409,
          'WALLET_NOT_BOUND',
          'A Blackout precisa vincular sua subconta PurinCash. Vendas manuais e Mercado Pago não entram nesta carteira.',
        );
      return {
        generation: shop.purin_connection as string,
        subaccount: shop.purin_subaccount as string,
        owner: shop.owner_id as string,
        uid: account.firebase_uid as string,
        enabled: settings?.withdrawals_enabled === true,
      };
    });
  }
  private async token(generation: string) {
    const c = await this.store.get(platform + '/connections/' + z.uuid().parse(generation));
    if (!c)
      throw new HttpError(503, 'WALLET_CREDENTIAL_MISSING', 'Conexão da carteira indisponível.');
    return JSON.parse(this.vault.open(c.ciphertext, 'purin:' + generation)).token as string;
  }
  private async provider(
    generation: string,
    subaccount: string,
    suffix = '',
    body?: Doc,
  ): Promise<Doc> {
    if (!this.liveEnabled)
      throw new HttpError(
        503,
        'WALLET_DEMO_ONLY',
        'Saques reais estão desativados neste ambiente.',
      );
    const token = await this.token(generation);
    let response: Response;
    try {
      response = await this.request(
        'https://api.purincash.com/v1/subaccounts/' + subaccount + suffix,
        {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: 'Bearer ' + token,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    } catch {
      throw new ProviderFailure(0);
    }
    const text = await response.text();
    let value: Doc;
    try {
      value = text.length <= 1000000 ? JSON.parse(text) : {};
    } catch {
      throw new ProviderFailure(0);
    }
    if (!response.ok)
      throw new ProviderFailure(
        response.status,
        Number.isFinite(value.minAmount) ? value.minAmount : undefined,
      );
    return value;
  }
  private audit(tx: DocumentTransaction, id: string, action: string, wid: string) {
    const key = randomUUID();
    tx.set('platform_audit/' + key, {
      id: key,
      account_id: id,
      action,
      withdrawal_id: wid,
      created_at: this.now(),
    });
  }
  private safe(row: Doc) {
    return {
      id: row.id,
      channel: row.channel ?? 'web',
      amountCents: row.amount_cents,
      destination: row.masked_key,
      pixType: row.pix_type,
      status:
        ['prepared', 'awaiting_confirmation'].includes(row.status) && row.expires_at <= this.now()
          ? 'expired'
          : row.status,
      createdAt: row.created_at,
      submittedAt: row.submitted_at ?? null,
      feeCents: row.fee_cents ?? null,
      gatewayFeeCents: row.gateway_fee_cents ?? null,
      blackoutFeeCents: row.blackout_fee_cents ?? null,
      netAmountCents: row.net_cents ?? null,
      completedAt: row.completed_at ?? null,
      reversedAt: row.reversed_at ?? null,
      updatedAt: row.updated_at ?? row.created_at,
      code: row.code ?? '',
      message: row.message ?? (row.status === 'cancelled' ? 'Saque cancelado.' : ''),
      estimatedBlackoutFeeCents:
        Math.floor((row.amount_cents * (row.markup_percent ?? 0)) / 100) + (row.markup_fixed ?? 0),
    };
  }
  async keys(id: string, actor: Actor) {
    await this.context(id, actor);
    const rows = await this.store.list(`merchant_wallets/${id}/pix_keys`, { limit: 20 });
    return rows.map((r) => ({ id: r.id, type: r.type, label: r.label, destination: r.masked_key }));
  }
  async saveKey(id: string, actor: Actor, raw: unknown) {
    await this.context(id, actor);
    const input = z
      .object({
        pixType: z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
        pixKey: z.string().max(200),
        label: z.string().trim().max(40).default(''),
      })
      .strict()
      .parse(raw);
    const key = pixKey.parse({ type: input.pixType, value: input.pixKey, holder: '' });
    const kid = tokenHash(key.type + ':' + key.value).slice(0, 32);
    await botTransaction(this.store, async (tx) => {
      const index = await tx.get(`merchant_wallets/${id}`);
      const existing = await tx.get(`merchant_wallets/${id}/pix_keys/${kid}`);
      const ids: string[] = index?.key_ids ?? [];
      if (ids.length >= 10 && !ids.includes(kid))
        throw new HttpError(409, 'PIX_KEY_LIMIT', 'Você pode salvar até dez chaves Pix.');
      tx.set(`merchant_wallets/${id}`, { ...index, key_ids: [...new Set([...ids, kid])] });
      tx.set(`merchant_wallets/${id}/pix_keys/${kid}`, {
        id: kid,
        type: key.type,
        label: input.label || existing?.label || pixTypes[key.type],
        masked_key: key.value.slice(0, 2) + '••••' + key.value.slice(-4),
        ciphertext: this.vault.seal(key.value, `wallet-key:${id}:${kid}`),
        created_at: this.now(),
      });
    });
    return { ok: true };
  }
  async removeKey(id: string, actor: Actor, kid: string) {
    await this.context(id, actor);
    if (!/^[a-f0-9]{32}$/.test(kid)) throw new HttpError(400, 'PIX_KEY_INVALID', 'Chave inválida.');
    await botTransaction(this.store, async (tx) => {
      const index = await tx.get(`merchant_wallets/${id}`);
      tx.set(`merchant_wallets/${id}`, {
        ...index,
        key_ids: (index?.key_ids ?? []).filter((v: string) => v !== kid),
      });
      tx.delete(`merchant_wallets/${id}/pix_keys/${kid}`);
    });
    return { ok: true };
  }
  async draft(id: string, actor: Actor, wid: string) {
    await this.context(id, actor);
    z.uuid().parse(wid);
    const row = await this.store.get(rowPath(id, wid));
    if (!row) throw new HttpError(404, 'WITHDRAWAL_NOT_FOUND', 'Saque não encontrado.');
    const body = JSON.parse(this.vault.open(row.request_ciphertext, `wallet:${id}:${wid}`));
    return {
      ...this.safe(row),
      fullDestination: body.pixKey,
      markupPercent: row.markup_percent,
      markupFixedCents: row.markup_fixed,
    };
  }
  private async sub(context: { generation: string; subaccount: string }) {
    const value = await this.provider(context.generation, context.subaccount);
    if (value.subaccountId !== context.subaccount)
      throw new HttpError(409, 'WALLET_ACCOUNT_MISMATCH', 'Subconta não corresponde à loja.');
    cents.parse(value.balanceCents);
    cents.parse(value.availableCents);
    cents.parse(value.medBlockedCents);
    z.number()
      .min(0)
      .max(100)
      .parse(value.payoutFeePercent ?? 0);
    cents.parse(value.payoutFeeFixedCents ?? 0);
    return value;
  }
  async read(id: string, actor: Actor) {
    const ctx = await this.context(id, actor);
    let withdrawals = await this.store.list(`merchant_wallets/${id}/withdrawals`, {
      limit: 20,
      orderBy: 'created_at',
    });
    for (const row of withdrawals.filter((r) => r.status === 'processing').slice(0, 1))
      await this.sync(id, actor, row.id);
    const [sub, movements] = await Promise.all([
      this.sub(ctx),
      this.provider(ctx.generation, ctx.subaccount, '/transactions?limit=20'),
    ]);
    if (movements.subaccountId !== undefined && movements.subaccountId !== ctx.subaccount)
      throw new HttpError(
        409,
        'WALLET_ACCOUNT_MISMATCH',
        'O extrato não corresponde à subconta da loja.',
      );
    withdrawals = await this.store.list(`merchant_wallets/${id}/withdrawals`, {
      limit: 20,
      orderBy: 'created_at',
    });
    return {
      balanceCents: sub.balanceCents,
      availableCents: sub.availableCents,
      blockedCents: sub.medBlockedCents,
      totalReceivedCents: sub.totalReceivedCents ?? null,
      checkedAt: this.now(),
      enabled: ctx.enabled,
      active: sub.active === true,
      markupPercent: sub.payoutFeePercent ?? 0,
      markupFixedCents: sub.payoutFeeFixedCents ?? 0,
      salePercent: sub.feePercent ?? 0,
      saleFixedCents: sub.feeFixedCents ?? 0,
      keys: await this.keys(id, actor),
      withdrawals: withdrawals.map((r) => this.safe(r)),
      transactions: await Promise.all(
        (movements.transactions ?? []).slice(0, 20).map(async (r: Doc) => {
          const reference = typeof r.refId === 'string' ? r.refId.slice(0, 160) : '';
          const orders =
            r.type === 'sale' && /^psc_[A-Za-z0-9_-]{1,120}$/.test(reference)
              ? await this.store.list(`bot_shops/${id}/orders`, {
                  limit: 2,
                  equals: ['purin_payment_id', reference],
                })
              : [];
          const order =
            orders.length === 1 &&
            orders[0].payment_method === 'purincash' &&
            orders[0].purin_subaccount === ctx.subaccount &&
            orders[0].currency === 'BRL'
              ? orders[0]
              : null;
          const commission =
            r.type === 'sale' && reference
              ? await this.store.get(`resale_partners/${id}/commissions/${tokenHash(reference)}`)
              : null;
          const resale =
            order?.resale ??
            (commission?.subaccount === ctx.subaccount && commission?.paymentId === reference
              ? commission
              : null);
          return {
            id: String(r.id ?? r.refId),
            reference,
            orderId: order ? String(order.id) : null,
            type: String(r.type),
            amountCents: cents.or(z.number().int().negative()).parse(r.amountCents),
            description: String(r.description ?? '').slice(0, 200),
            createdAt: r.createdAt,
            breakdown:
              r.type === 'sale' ? saleBreakdown(r, order?.total ?? commission?.grossCents) : null,
            resale: resale ? { baseCents: resale.baseCents, kind: resale.kind } : null,
          };
        }),
      ),
    };
  }
  async prepare(id: string, actor: Actor, raw: unknown) {
    if (raw && typeof raw === 'object' && 'savedKeyId' in raw) {
      await this.context(id, actor);
      const input = z
        .object({
          requestId: z.uuid(),
          amountCents: z.number().int(),
          savedKeyId: z.string().regex(/^[a-f0-9]{32}$/),
        })
        .strict()
        .parse(raw);
      const saved = await this.store.get(`merchant_wallets/${id}/pix_keys/${input.savedKeyId}`);
      if (!saved)
        throw new HttpError(404, 'PIX_KEY_NOT_FOUND', 'Chave removida. Escolha outra chave.');
      raw = {
        requestId: input.requestId,
        amountCents: input.amountCents,
        pixType: saved.type,
        pixKey: this.vault.open(saved.ciphertext, `wallet-key:${id}:${input.savedKeyId}`),
      };
    }
    const value = z
      .object({
        requestId: z.uuid(),
        amountCents: z.number().int().min(1).max(500000),
        pixType: z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
        pixKey: z.string().max(254),
      })
      .strict()
      .parse(raw);
    const ctx = await this.context(id, actor);
    if (!ctx.enabled)
      throw new HttpError(
        409,
        'WITHDRAWALS_DISABLED',
        'Saques ainda aguardam habilitação pela Blackout.',
      );
    const destination = pixKey.parse({ type: value.pixType, value: value.pixKey, holder: '' });
    if (destination.value.length > 200)
      throw new HttpError(400, 'WALLET_KEY_INVALID', 'Chave Pix muito longa.');
    const sub = await this.sub(ctx);
    if (sub.active !== true || value.amountCents > sub.availableCents)
      throw new HttpError(
        409,
        'WALLET_BALANCE',
        'Valor acima do saldo disponível ou subconta inativa.',
      );
    const blackoutFee =
      Math.floor((value.amountCents * (sub.payoutFeePercent ?? 0)) / 100) +
      (sub.payoutFeeFixedCents ?? 0);
    if (value.amountCents <= blackoutFee)
      throw new HttpError(
        400,
        'WALLET_AMOUNT_TOO_LOW',
        'O valor precisa ser maior que a taxa do saque.',
      );
    const body = {
      amountCents: value.amountCents,
      pixKey: destination.value,
      idempotencyKey: 'blackout_' + value.requestId.replaceAll('-', ''),
    };
    const hash = tokenHash(JSON.stringify(body));
    await this.saveKey(id, actor, { pixType: destination.type, pixKey: destination.value });
    await botTransaction(this.store, async (tx) => {
      const existing = await tx.get(rowPath(id, value.requestId));
      if (existing) {
        if (existing.request_hash !== hash)
          throw new HttpError(
            409,
            'WITHDRAWAL_CHANGED',
            'Esta solicitação já existe com outros dados.',
          );
        return;
      }
      tx.set(rowPath(id, value.requestId), {
        id: value.requestId,
        amount_cents: value.amountCents,
        pix_type: destination.type,
        masked_key:
          destination.value.length <= 6
            ? '••••'
            : destination.value.slice(0, 2) + '••••' + destination.value.slice(-4),
        generation: ctx.generation,
        subaccount: ctx.subaccount,
        owner: ctx.owner,
        owner_uid: ctx.uid,
        request_hash: hash,
        request_ciphertext: this.vault.seal(
          JSON.stringify(body),
          `wallet:${id}:${value.requestId}`,
        ),
        status: 'prepared',
        channel: 'uid' in actor ? 'web' : 'telegram',
        markup_percent: sub.payoutFeePercent ?? 0,
        markup_fixed: sub.payoutFeeFixedCents ?? 0,
        created_at: this.now(),
        expires_at: new Date(this.now().getTime() + 300000),
      });
      this.audit(tx, id, 'wallet.withdrawal_prepared', value.requestId);
    });
    const saved = (await this.store.get(rowPath(id, value.requestId)))!;
    return {
      ...this.safe(saved),
      fullDestination: destination.value,
      markupPercent: saved.markup_percent,
      markupFixedCents: saved.markup_fixed,
    };
  }
  async requestApproval(id: string, uid: string, raw: unknown) {
    const { draftId } = z.object({ draftId: z.uuid() }).strict().parse(raw);
    return this.execute(id, { uid }, draftId);
  }
  private confirmText(row: Doc, key: string) {
    const fee =
      Math.floor((row.amount_cents * (row.markup_percent ?? 0)) / 100) + (row.markup_fixed ?? 0);
    return `💸 CONFIRMAR SAQUE\n\nValor solicitado: ${money(row.amount_cents)}\nTaxa Blackout: ${money(fee)}\nApós taxa Blackout: ${money(Math.max(0, row.amount_cents - fee))}\nTarifa Purin: descontada adicionalmente pelo provedor.\n\nChave Pix: ${key}\n\nConfira os dados. Confirmar envia o saque, sem precisar acessar o site. Válido por 5 minutos.`;
  }
  private confirmButtons(id: string): WalletScreen['markup'] {
    return botButtons([
      [['Confirmar saque', 'wallet:confirm:' + id]],
      [['Cancelar', 'wallet:cancel:' + id]],
    ]);
  }
  async cancel(id: string, actor: Actor, wid: string) {
    await this.context(id, actor);
    z.uuid().parse(wid);
    await botTransaction(this.store, async (tx) => {
      const row = await tx.get(rowPath(id, wid));
      if (!row) throw new HttpError(404, 'WITHDRAWAL_NOT_FOUND', 'Saque não encontrado.');
      if (!['prepared', 'awaiting_confirmation', 'cancelled'].includes(row.status))
        throw new HttpError(409, 'WITHDRAWAL_SENT', 'Saque já enviado. Consulte o andamento.');
      tx.set(rowPath(id, wid), { ...row, status: 'cancelled' });
      this.audit(tx, id, 'wallet.withdrawal_cancelled', wid);
    });
  }
  async execute(id: string, actor: Actor, wid: string) {
    z.uuid().parse(wid);
    const ctx = await this.context(id, actor),
      row = await this.store.get(rowPath(id, wid));
    if (!row) throw new HttpError(404, 'WITHDRAWAL_NOT_FOUND', 'Saque não encontrado.');
    if (row.status === 'processing') return this.sync(id, actor, wid);
    if (!['prepared', 'awaiting_confirmation'].includes(row.status)) return this.safe(row);
    const channel = 'uid' in actor ? 'web' : 'telegram';
    if ((row.channel ?? 'web') !== channel)
      throw new HttpError(
        409,
        'WITHDRAWAL_CHANNEL',
        'Confirme o saque no mesmo canal em que iniciou a solicitação.',
      );
    if (row.owner_uid !== ctx.uid)
      throw new HttpError(403, 'WITHDRAWAL_BLOCKED', 'Saque não autorizado.');
    if (
      !ctx.enabled ||
      row.owner !== ctx.owner ||
      row.generation !== ctx.generation ||
      row.subaccount !== ctx.subaccount ||
      row.expires_at <= this.now()
    )
      throw new HttpError(
        409,
        'WITHDRAWAL_EXPIRED',
        'Solicitação vencida ou conexão alterada. Prepare outro saque.',
      );
    const sub = await this.sub(ctx);
    if (sub.active !== true || row.amount_cents > sub.availableCents)
      throw new HttpError(409, 'WALLET_BALANCE', 'Saldo disponível insuficiente.');
    if (
      (sub.payoutFeePercent ?? 0) !== row.markup_percent ||
      (sub.payoutFeeFixedCents ?? 0) !== row.markup_fixed
    )
      throw new HttpError(
        409,
        'WALLET_FEES_CHANGED',
        'As taxas mudaram. Prepare outra solicitação antes de confirmar.',
      );
    const acquired = await botTransaction(this.store, async (tx) => {
      const [current, settings, shop, account, setup, runtime] = await Promise.all([
        tx.get(rowPath(id, wid)),
        tx.get(platform),
        tx.get(botRoot(id)),
        tx.get('merchant_accounts/' + id),
        tx.get('merchant_bot_setup/' + id),
        tx.get('bot_runtimes/' + id),
      ]);
      if (!current || !['prepared', 'awaiting_confirmation'].includes(current.status)) return false;
      if (
        settings?.withdrawals_enabled !== true ||
        (!('uid' in actor) && runtime?.generation !== actor.auth.generation) ||
        current.owner_uid !== ctx.uid ||
        account?.firebase_uid !== ctx.uid ||
        (current.channel ?? 'web') !== channel ||
        shop?.owner_id !== ctx.owner ||
        setup?.telegram_user_id !== ctx.owner ||
        shop?.owner_bot_id !== setup?.bot_id ||
        account?.access_status !== 'approved' ||
        shop.purin_connection !== row.generation ||
        shop.purin_subaccount !== row.subaccount ||
        current.expires_at <= this.now()
      )
        throw new HttpError(403, 'WITHDRAWAL_BLOCKED', 'Saque não autorizado.');
      if (settings.active_withdrawal && settings.active_withdrawal !== id + ':' + wid)
        throw new HttpError(
          409,
          'WITHDRAWAL_BUSY',
          'Existe outro saque em processamento. Aguarde e tente mais tarde.',
        );
      tx.set(platform, { ...settings, active_withdrawal: id + ':' + wid });
      tx.set(rowPath(id, wid), { ...current, status: 'processing', submitted_at: this.now() });
      this.audit(tx, id, 'wallet.withdrawal_confirmed_' + channel, wid);
      return true;
    });
    if (!acquired) return this.safe((await this.store.get(rowPath(id, wid)))!);
    const body = JSON.parse(this.vault.open(row.request_ciphertext, `wallet:${id}:${wid}`));
    try {
      await this.provider(row.generation, row.subaccount, '/payout', body);
    } catch (error) {
      if (error instanceof ProviderFailure && [400, 401, 403, 404, 422].includes(error.status)) {
        const message =
          error.status === 403
            ? 'A PurinCash ainda não liberou saques desta conta ou a permissão Sacar de subconta.'
            : error.minimum
              ? `O mínimo de saque informado pelo provedor é ${money(Math.round(error.minimum * 100))}.`
              : 'A PurinCash recusou este saque. Confira saldo, chave Pix e os limites da conta.';
        await this.finish(id, wid, { status: 'failed', message });
        return this.safe((await this.store.get(rowPath(id, wid)))!);
      }
      // Network failures, 202, 409, 429 and ambiguous responses never trigger another POST.
    }
    return this.sync(id, actor, wid);
  }
  private async finish(id: string, wid: string, fields: Doc) {
    await botTransaction(this.store, async (tx) => {
      const [row, settings] = await Promise.all([tx.get(rowPath(id, wid)), tx.get(platform)]);
      if (!row) return;
      tx.set(rowPath(id, wid), { ...row, ...fields, updated_at: this.now() });
      if (
        settings?.active_withdrawal === id + ':' + wid &&
        ['completed', 'failed', 'reversed'].includes(fields.status)
      )
        tx.set(platform, { ...settings, active_withdrawal: null });
      if (row.status !== fields.status)
        this.audit(tx, id, 'wallet.withdrawal_' + fields.status, wid);
    });
  }
  async sync(id: string, actor: Actor, wid: string) {
    await this.context(id, actor);
    z.uuid().parse(wid);
    const row = await this.store.get(rowPath(id, wid));
    if (!row) throw new HttpError(404, 'WITHDRAWAL_NOT_FOUND', 'Saque não encontrado.');
    if (!['processing', 'completed'].includes(row.status)) return this.safe(row);
    const body = JSON.parse(this.vault.open(row.request_ciphertext, `wallet:${id}:${wid}`));
    let result: Doc;
    try {
      result = await this.provider(
        row.generation,
        row.subaccount,
        '/payouts/saq_idem_' + body.idempotencyKey,
      );
    } catch {
      return {
        ...this.safe(row),
        message:
          'Saque em conferência. Atualize o andamento; não solicite outro saque deste valor.',
      };
    }
    if (
      result.subaccountId !== row.subaccount ||
      result.amountCents !== row.amount_cents ||
      !['completed', 'processing', 'failed'].includes(result.status)
    )
      throw new HttpError(
        409,
        'WALLET_PAYOUT_MISMATCH',
        'A resposta do saque precisa de conferência pela Blackout.',
      );
    const status =
      result.status === 'failed'
        ? result.reversed === true
          ? 'reversed'
          : 'processing'
        : result.status;
    for (const field of ['feeCents', 'platformFeeCents', 'netAmountCents'])
      if (result[field] != null) cents.parse(result[field]);
    const breakdown = payoutBreakdown(result);
    const fee = breakdown.totalFeeCents,
      net = breakdown.netCents;
    if (
      net !== null &&
      (net > row.amount_cents || (fee !== null && fee + net !== row.amount_cents))
    )
      throw new HttpError(409, 'WALLET_PAYOUT_MISMATCH', 'Valor do saque precisa de conferência.');
    await this.finish(id, wid, {
      status,
      fee_cents: fee,
      gateway_fee_cents: breakdown.gatewayFeeCents,
      blackout_fee_cents: breakdown.blackoutFeeCents,
      net_cents: net,
      completed_at:
        typeof result.completedAt === 'string' && Number.isFinite(Date.parse(result.completedAt))
          ? new Date(result.completedAt)
          : null,
      reversed_at:
        typeof result.reversedAt === 'string' && Number.isFinite(Date.parse(result.reversedAt))
          ? new Date(result.reversedAt)
          : null,
      updated_at: this.now(),
      code: typeof result.code === 'string' ? result.code.slice(0, 80) : '',
      message:
        status === 'completed'
          ? 'Pix enviado e confirmado pelo banco.'
          : status === 'reversed'
            ? 'Saque recusado e saldo devolvido à carteira.'
            : 'Saque em processamento ou conferência. Atualize o andamento.',
    });
    return this.safe((await this.store.get(rowPath(id, wid)))!);
  }
  async telegram(auth: RuntimeAccess, update: TelegramUpdate): Promise<WalletScreen | null> {
    const callback = update.callback_query,
      msg = update.message,
      cmd = callback?.data ?? msg?.text ?? '',
      user = String(callback?.from.id ?? msg?.from?.id ?? ''),
      chat = callback?.message?.chat ?? msg?.chat;
    const sid = botPath(auth.accountId, 'wallet_sessions', user || 'unknown');
    const session = msg?.text || callback ? await this.store.get(sid) : null;
    const isWallet = cmd === 'admin:wallet' || cmd === '/carteira' || cmd.startsWith('wallet:');
    if (!isWallet && (callback || cmd.startsWith('/'))) {
      if (session)
        await botTransaction(this.store, async (tx) => {
          tx.delete(sid);
        });
      return null;
    }
    if (
      !isWallet &&
      !(session && session.expires_at > this.now() && msg?.text && !cmd.startsWith('/'))
    )
      return null;
    if (!chat || chat.type !== 'private' || String(chat.id) !== user) return null;
    const actor = { telegram: user, auth },
      id = auth.accountId,
      screen = (text: string, markup: WalletScreen['markup'] = back()): WalletScreen => ({
        text,
        markup,
      });
    try {
      await this.context(id, actor);
    } catch {
      return screen('Carteira exclusiva do lojista confirmado.');
    }
    const receipt = botPath(id, 'wallet_updates', String(update.update_id));
    const prior = await this.store.get(receipt);
    if (prior?.ciphertext)
      return JSON.parse(
        this.vault.open(prior.ciphertext, `${id}:wallet-update:${update.update_id}`),
      );
    const acquired = await botTransaction(this.store, async (tx) => {
      if (await tx.get(receipt)) return false;
      tx.set(receipt, { started_at: this.now() });
      return true;
    });
    if (!acquired) return screen('Esta ação está em processamento. Abra a carteira para conferir.');
    let output: WalletScreen;
    try {
      await this.context(id, actor);
      if (cmd === 'admin:wallet' || cmd === '/carteira' || cmd === 'wallet:history') {
        await botTransaction(this.store, async (tx) => {
          tx.delete(sid);
        });
        const w = await this.read(id, actor);
        output = screen(
          `💳 CARTEIRA BLACKOUT\n\n💰 Disponível: ${money(w.availableCents)}\nSaldo total: ${money(w.balanceCents)}\n🛡 Em disputa: ${money(w.blockedCents)}\n\nVendas: ${w.salePercent}% + ${money(w.saleFixedCents)} de comissão Blackout.\nSaques: ${w.markupPercent}% + ${money(w.markupFixedCents)} Blackout.\nTarifas Purin são adicionais.\n\n${
            cmd === 'wallet:history'
              ? w.withdrawals
                  .slice(0, 8)
                  .map(
                    (r) =>
                      `${money(r.amountCents)} · ${r.status}${r.code ? ' · ' + r.code : ''}\nPurin: ${r.gatewayFeeCents == null ? 'não informada' : money(r.gatewayFeeCents)} · Blackout: ${r.blackoutFeeCents == null ? 'não informada' : money(r.blackoutFeeCents)} · Líquido: ${r.netAmountCents == null ? 'não informado' : money(r.netAmountCents)}`,
                  )
                  .join('\n') || 'Nenhum saque solicitado.'
              : 'Somente as vendas Pix Blackout entram nesta carteira.'
          }${!w.enabled ? '\nSaques aguardam habilitação pela Blackout.' : ''}`,
          botButtons([
            [
              ['Sacar', 'wallet:new'],
              ['Histórico de saques', 'wallet:history'],
            ],
            [
              ['Atualizar', 'admin:wallet'],
              ['Voltar', 'admin'],
            ],
            [['Minhas chaves Pix', 'wallet:keys']],
          ]),
        );
      } else if (cmd === 'wallet:keys') {
        const keys = await this.keys(id, actor);
        await botTransaction(this.store, async (tx) => {
          tx.set(sid, { step: 'save_type', expires_at: new Date(this.now().getTime() + 300000) });
        });
        output = screen(
          '🔑 MINHAS CHAVES PIX\n\n' +
            (keys.map((k) => `${k.label} · ${k.destination}`).join('\n') ||
              'Nenhuma chave salva.') +
            '\n\nEscolha um tipo para adicionar uma chave ou remova uma das chaves abaixo.',
          botButtons([
            ...keys.map(
              (k) =>
                [[`Remover ${k.label} · ${k.destination}`, 'wallet:remove:' + k.id]] as [
                  string,
                  string,
                ][],
            ),
            ...Object.entries(pixTypes).map(
              ([type, label]) =>
                [[`Adicionar ${label}`, 'wallet:save-type:' + type]] as [string, string][],
            ),
            [['Voltar', 'admin:wallet']],
          ]),
        );
      } else if (cmd.startsWith('wallet:remove:')) {
        await this.removeKey(id, actor, cmd.slice(14));
        output = screen(
          'Chave Pix removida.',
          botButtons([[['Minhas chaves Pix', 'wallet:keys']]]),
        );
      } else if (cmd.startsWith('wallet:save-type:')) {
        const type = z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']).parse(cmd.slice(17));
        await botTransaction(this.store, async (tx) => {
          tx.set(sid, {
            step: 'save_key',
            pixType: type,
            expires_at: new Date(this.now().getTime() + 300000),
          });
        });
        output = screen(`Envie a chave Pix do tipo ${pixTypes[type]} que deseja salvar.`);
      } else if (session?.step === 'save_key' && msg?.text) {
        await this.saveKey(id, actor, { pixType: session.pixType, pixKey: msg.text.trim() });
        await botTransaction(this.store, async (tx) => {
          tx.delete(sid);
        });
        output = screen(
          '🔑 Chave Pix salva. Ela poderá ser usada nos próximos saques.',
          botButtons([[['Minhas chaves Pix', 'wallet:keys']]]),
        );
      } else if (cmd.startsWith('wallet:use:')) {
        if (!session?.amount || session.expires_at <= this.now())
          throw new HttpError(409, 'WITHDRAWAL_EXPIRED', 'Comece novamente em Sacar.');
        const draft = await this.prepare(id, actor, {
          requestId: randomUUID(),
          amountCents: session.amount,
          savedKeyId: cmd.slice(11),
        });
        await botTransaction(this.store, async (tx) => {
          tx.delete(sid);
        });
        output = screen(
          this.confirmText((await this.store.get(rowPath(id, draft.id)))!, draft.fullDestination),
          this.confirmButtons(draft.id),
        );
      } else if (cmd === 'wallet:new') {
        const w = await this.read(id, actor);
        if (!w.enabled || !w.active || w.availableCents <= 0)
          throw new HttpError(
            409,
            'WALLET_UNAVAILABLE',
            !w.enabled
              ? 'Saques aguardam habilitação pela Blackout.'
              : !w.active
                ? 'Sua subconta está inativa.'
                : 'Você ainda não tem saldo disponível para sacar.',
          );
        await botTransaction(this.store, async (tx) => {
          tx.set(sid, { step: 'amount', expires_at: new Date(this.now().getTime() + 300000) });
        });
        output = screen(
          `Disponível: ${money(w.availableCents)}.\nEnvie o valor bruto que deseja sacar em reais. Exemplo: 10,00. As tarifas do provedor são descontadas desse valor.`,
        );
      } else if (cmd.startsWith('wallet:type:')) {
        const type = z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']).parse(cmd.slice(12)),
          current = await this.store.get(sid);
        if (!current?.amount || current.expires_at <= this.now())
          throw new HttpError(409, 'WITHDRAWAL_EXPIRED', 'Comece novamente em Sacar.');
        await botTransaction(this.store, async (tx) => {
          tx.set(sid, { ...current, step: 'key', pixType: type });
        });
        output = screen(
          `Envie a chave Pix do tipo ${pixTypes[type]}.${type === 'phone' ? ' Use +55, DDD e número.' : ''}`,
        );
      } else if (cmd.startsWith('wallet:confirm:')) {
        const row = await this.execute(id, actor, cmd.slice(15));
        output = screen(
          `${row.message || 'Saque solicitado.'}\nValor bruto: ${money(row.amountCents)}${row.netAmountCents !== null ? '\nValor líquido: ' + money(row.netAmountCents) : ''}`,
          botButtons([
            [['Atualizar saque', 'wallet:status:' + row.id]],
            [['Carteira', 'admin:wallet']],
          ]),
        );
      } else if (cmd.startsWith('wallet:cancel:')) {
        await this.cancel(id, actor, cmd.slice(14));
        output = screen('Saque cancelado antes do envio.');
      } else if (cmd.startsWith('wallet:status:')) {
        const r = await this.sync(id, actor, cmd.slice(14));
        output = screen(
          `${money(r.amountCents)} · ${r.status}\n${r.message}`,
          botButtons([
            [['Atualizar saque', 'wallet:status:' + r.id]],
            [['Carteira', 'admin:wallet']],
          ]),
        );
      } else if (session?.step === 'amount') {
        const match = /^(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(msg!.text!.trim());
        if (!match)
          throw new HttpError(
            400,
            'WALLET_AMOUNT',
            'Envie o valor como 10,00, sem separador de milhar.',
          );
        const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
        if (amount < 1 || amount > 500000)
          throw new HttpError(
            400,
            'WALLET_AMOUNT',
            'Informe de R$ 0,01 a R$ 5.000,00. O provedor pode exigir um mínimo maior.',
          );
        await botTransaction(this.store, async (tx) => {
          tx.set(sid, { ...session, step: 'type', amount });
        });
        const keys = await this.keys(id, actor);
        output = screen(
          'Escolha uma chave salva ou o tipo de uma nova chave Pix.',
          botButtons([
            ...keys.map(
              (k) =>
                [[`${k.label} · ${k.destination}`, 'wallet:use:' + k.id]] as [string, string][],
            ),
            ...Object.entries(pixTypes).map(
              ([type, label]) => [[label, 'wallet:type:' + type]] as [string, string][],
            ),
          ]),
        );
      } else if (session?.step === 'key') {
        const draft = await this.prepare(id, actor, {
          requestId: randomUUID(),
          amountCents: session.amount,
          pixType: session.pixType,
          pixKey: msg!.text!.trim(),
        });
        await botTransaction(this.store, async (tx) => {
          tx.delete(sid);
        });
        const row = await this.store.get(rowPath(id, draft.id));
        output = screen(
          this.confirmText(row!, draft.fullDestination),
          this.confirmButtons(draft.id),
        );
      } else output = screen('Abra a carteira para continuar.');
    } catch (error) {
      output = screen(
        error instanceof HttpError
          ? error.message
          : error instanceof z.ZodError
            ? 'Confira o valor e o tipo da chave Pix.'
            : 'Carteira temporariamente indisponível. Tente novamente.',
      );
    }
    await botTransaction(this.store, async (tx) => {
      tx.set(receipt, {
        ciphertext: this.vault.seal(
          JSON.stringify(output),
          `${id}:wallet-update:${update.update_id}`,
        ),
        created_at: this.now(),
      });
    });
    return output;
  }
}
