import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import { botTransaction } from './bot-data.js';
import { HttpError } from './types.js';

const cents = z.number().int().min(1).max(10000000);
const identifier = z.uuid();
const plans = z.object({ monthly: cents, quarterly: cents, annual: cents }).strict();
export const affiliateInput = z
  .object({ revision: z.number().int().nonnegative(), enabled: z.boolean(), prices: plans })
  .strict();
const fail = (code: string, message: string) => new HttpError(409, code, message);
const accountPath = (id: string) => 'merchant_accounts/' + identifier.parse(id);

// Explicit snapshots prevent later price changes from altering an existing sale.
export function resaleBreakdown(raw: unknown) {
  const input = z
    .object({
      grossCents: cents,
      baseCents: cents,
      gatewayFeeCents: z.number().int().nonnegative().max(10000000),
      kind: z.enum(['plan', 'product']),
      blackoutFeeCents: z.number().int().nonnegative().max(10000000).default(0),
    })
    .strict()
    .parse(raw);
  if (input.kind === 'plan' && input.blackoutFeeCents !== 0)
    throw fail('PLAN_MARKUP_FORBIDDEN', 'A revenda de planos não tem comissão Blackout adicional.');
  const margin =
    input.grossCents - input.baseCents - input.gatewayFeeCents - input.blackoutFeeCents;
  return {
    ...input,
    partnerCents: Math.max(0, margin),
    shortfallCents: Math.max(0, -margin),
    status: margin < 0 ? 'review_required' : 'reconciled',
  };
}

export class ResaleCatalog {
  constructor(
    readonly store: DocumentStore,
    readonly now = () => new Date(),
  ) {}
  private async owner(tx: DocumentTransaction, id: string, uid: string) {
    const account = await tx.get(accountPath(id));
    if (!account || account.firebase_uid !== uid || account.access_status !== 'approved')
      throw new HttpError(
        403,
        'RESELLER_OWNER_REQUIRED',
        'Acesso exclusivo ao responsável da loja.',
      );
    return account;
  }
  async affiliateSettings(id: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      await this.owner(tx, id, uid);
      const settings = await tx.get('platform_billing/settings'),
        offer = await tx.get('resale_partners/' + id);
      return {
        revision: offer?.revision ?? 0,
        enabled: offer?.enabled ?? false,
        prices: offer?.prices ?? settings?.prices ?? {},
        basePrices: settings?.prices ?? {},
        policy: {
          planCommissionPercent: 0,
          gatewayFeePaidBy: 'partner',
          baseProtected: true,
          renewals: 'through_partner',
        },
        checkoutReady: false,
      };
    });
  }
  async saveAffiliate(id: string, uid: string, raw: unknown) {
    const input = affiliateInput.parse(raw);
    return botTransaction(this.store, async (tx) => {
      await this.owner(tx, id, uid);
      const base = await tx.get('platform_billing/settings'),
        offer = await tx.get('resale_partners/' + id);
      if ((offer?.revision ?? 0) !== input.revision)
        throw fail('OFFER_CHANGED', 'Atualize os preços antes de salvar.');
      for (const plan of ['monthly', 'quarterly', 'annual'] as const) {
        if (!Number.isSafeInteger(base?.prices?.[plan]) || base!.prices[plan] <= 0)
          throw fail('BASE_PRICE_MISSING', 'Configure os preços Blackout primeiro.');
        if (input.prices[plan] <= base!.prices[plan])
          throw fail(
            'RESELLER_PRICE_TOO_LOW',
            'O preço de revenda deve ser maior que o valor base. A tarifa Purin sai da margem.',
          );
      }
      tx.set('resale_partners/' + id, {
        id,
        ...input,
        revision: input.revision + 1,
        updated_at: this.now(),
      });
      tx.set('resale_audit/' + randomUUID(), {
        actor: uid,
        account_id: id,
        action: 'affiliate.prices_saved',
        created_at: this.now(),
      });
      return { ok: true };
    });
  }
  // Server-only quotation: never accept seller, base price or margin supplied by a buyer.
  async quotePlan(partnerId: string, buyerUid: string, plan: 'monthly' | 'quarterly' | 'annual') {
    identifier.parse(partnerId);
    z.enum(['monthly', 'quarterly', 'annual']).parse(plan);
    return botTransaction(this.store, async (tx) => {
      const account = await tx.get(accountPath(partnerId)),
        offer = await tx.get('resale_partners/' + partnerId),
        base = await tx.get('platform_billing/settings');
      if (!account || account.access_status !== 'approved' || !offer?.enabled)
        throw fail('RESELLER_DISABLED', 'Revendedor indisponível.');
      if (account.firebase_uid === buyerUid)
        throw fail('SELF_REFERRAL', 'Não é possível comprar pelo próprio vínculo de revenda.');
      const total = cents.parse(offer.prices?.[plan]),
        cost = cents.parse(base?.prices?.[plan]);
      if (total <= cost)
        throw fail('RESELLER_PRICE_TOO_LOW', 'O revendedor precisa atualizar os preços.');
      return {
        kind: 'plan' as const,
        partnerId,
        plan,
        total,
        baseCents: cost,
        offerRevision: offer.revision,
        baseRevision: base?.revision ?? 0,
        blackoutFeeCents: 0,
        gatewayFeePaidBy: 'partner' as const,
        renewals: 'through_partner' as const,
      };
    });
  }
  async grantProduct(supplierId: string, uid: string, raw: unknown) {
    const input = z
      .object({
        partnerId: identifier,
        productId: z.string().regex(/^[a-f0-9]{12}$/),
        baseCents: cents,
        enabled: z.boolean(),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(raw);
    if (input.partnerId === supplierId)
      throw fail('SELF_RESALE', 'Selecione outra loja para revenda.');
    return botTransaction(this.store, async (tx) => {
      await this.owner(tx, supplierId, uid);
      const partner = await tx.get(accountPath(input.partnerId)),
        shop = await tx.get('bot_shops/' + supplierId);
      const target = `resale_suppliers/${supplierId}/grants/${input.partnerId}_${input.productId}`,
        current = await tx.get(target);
      if (!partner || partner.access_status !== 'approved')
        throw fail('RESELLER_DISABLED', 'Revendedor indisponível.');
      if (!shop?.products.some((p: Doc) => p.id === input.productId))
        throw fail('PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      if ((current?.revision ?? 0) !== input.revision)
        throw fail('GRANT_CHANGED', 'Atualize a autorização antes de salvar.');
      tx.set(target, {
        id: input.partnerId + '_' + input.productId,
        supplierId,
        ...input,
        revision: input.revision + 1,
        updated_at: this.now(),
      });
      tx.set('resale_audit/' + randomUUID(), {
        actor: uid,
        account_id: supplierId,
        action: 'resale.grant_saved',
        partnerId: input.partnerId,
        productId: input.productId,
        created_at: this.now(),
      });
      return { ok: true };
    });
  }
  async quoteProduct(
    supplierId: string,
    partnerId: string,
    uid: string,
    productId: string,
    priceCents: number,
  ) {
    identifier.parse(supplierId);
    identifier.parse(partnerId);
    z.string()
      .regex(/^[a-f0-9]{12}$/)
      .parse(productId);
    cents.parse(priceCents);
    return botTransaction(this.store, async (tx) => {
      await this.owner(tx, partnerId, uid);
      const supplier = await tx.get(accountPath(supplierId)),
        grant = await tx.get(`resale_suppliers/${supplierId}/grants/${partnerId}_${productId}`),
        shop = await tx.get('bot_shops/' + supplierId);
      const product = shop?.products.find((p: Doc) => p.id === productId && p.enabled);
      if (supplier?.access_status !== 'approved' || !grant?.enabled || !product)
        throw fail('SUPPLIER_UNAVAILABLE', 'Fornecedor ou autorização indisponível.');
      if (priceCents <= grant.baseCents)
        throw fail('RESELLER_PRICE_TOO_LOW', 'Preço insuficiente para revenda.');
      // Only public catalog details. No stock document, file id, token or encrypted delivery.
      return {
        supplierId,
        partnerId,
        productId,
        title: product.title,
        description: product.description,
        stock: product.stock,
        stockMode: product.stock_mode ?? 'individual',
        priceCents,
        baseCents: grant.baseCents,
        grantRevision: grant.revision,
      };
    });
  }
}
