import { tokenHash } from './accounts.js';
import { resaleRecipient } from './resale-finance.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import { botTransaction } from './bot-data.js';
import { HttpError } from './types.js';
import type { MerchantConsole } from './merchant-console.js';
import { ResaleCatalog } from './resale-catalog.js';
const root = 'resale_platform/settings';
const id = z.uuid();
export const capability = z.enum(['products', 'plans']);
const status = z.enum(['none', 'requested', 'approved', 'revoked']);
const profilePath = (account: string) => 'resale_profiles/' + id.parse(account);
const permissions = (row: Doc | null) => ({
  products: row?.products ?? 'none',
  plans: row?.plans ?? 'none',
});
export class ResaleProgram {
  constructor(
    readonly store: DocumentStore,
    readonly isAdmin: (uid: string) => Promise<boolean>,
    readonly console: MerchantConsole,
    readonly now = () => new Date(),
  ) {}
  private async authority(uid: string, tx?: DocumentTransaction) {
    if (!(await this.isAdmin(uid)))
      throw new HttpError(403, 'PLATFORM_OWNER_REQUIRED', 'Ação exclusiva da dona da Blackout.');
    const settings = await (tx ? tx.get(root) : this.store.get(root));
    if (settings && settings.owner_uid !== uid)
      throw new HttpError(403, 'PLATFORM_OWNER_REQUIRED', 'Ação exclusiva da dona da Blackout.');
    return settings;
  }
  private async merchant(tx: DocumentTransaction, accountId: string, uid: string) {
    const account = await tx.get('merchant_accounts/' + id.parse(accountId));
    if (!account || account.firebase_uid !== uid || account.access_status !== 'approved')
      throw new HttpError(
        403,
        'RESELLER_OWNER_REQUIRED',
        'Acesso exclusivo ao responsável da loja.',
      );
    return account;
  }
  private audit(tx: DocumentTransaction, uid: string, accountId: string, action: string) {
    tx.set('resale_audit/' + randomUUID(), {
      actor: uid,
      account_id: accountId,
      action,
      created_at: this.now(),
    });
  }
  async initialize(uid: string, accountId: string) {
    await this.authority(uid);
    return botTransaction(this.store, async (tx) => {
      const current = await this.authority(uid, tx);
      const account = await this.merchant(tx, accountId, uid),
        shop = await tx.get('bot_shops/' + accountId);
      if (!shop)
        throw new HttpError(
          409,
          'GLOBAL_STOCK_NOT_READY',
          'Prepare sua loja antes de usá-la como estoque global.',
        );
      if (current) {
        if (current.supplier_id !== accountId)
          throw new HttpError(409, 'GLOBAL_STOCK_FIXED', 'O estoque global já está vinculado.');
        return { ok: true };
      }
      tx.set(root, { owner_uid: uid, supplier_id: accountId, created_at: this.now() });
      this.audit(tx, uid, account.id, 'global_stock.initialized');
      return { ok: true };
    });
  }
  async global(uid: string) {
    const settings = await this.authority(uid);
    if (!settings) return { configured: false as const };
    const account = await this.store.get('merchant_accounts/' + settings.supplier_id);
    if (!account || account.firebase_uid !== uid)
      throw new HttpError(
        409,
        'GLOBAL_STOCK_OWNER_CHANGED',
        'Confira o responsável do estoque global.',
      );
    return {
      configured: true as const,
      supplierId: settings.supplier_id,
      catalog: await this.console.read(settings.supplier_id, uid),
    };
  }
  async stock(uid: string, productId: string) {
    const settings = await this.authority(uid);
    if (!settings)
      throw new HttpError(409, 'GLOBAL_STOCK_NOT_READY', 'Vincule o estoque global primeiro.');
    return this.console.inventory(settings.supplier_id, uid, productId);
  }
  async manageGlobal(uid: string, operation: string, raw: unknown) {
    const settings = await this.authority(uid);
    if (!settings)
      throw new HttpError(409, 'GLOBAL_STOCK_NOT_READY', 'Vincule o estoque global primeiro.');
    const supplier = settings.supplier_id;
    if (operation === 'product') return this.console.saveProduct(supplier, uid, raw);
    if (operation === 'stock-add') return this.console.addStock(supplier, uid, raw);
    if (operation === 'stock-manage') return this.console.manageStock(supplier, uid, raw);
    if (operation === 'stock-mode') return this.console.stockMode(supplier, uid, raw);
    throw new HttpError(400, 'INVALID_ACTION', 'Ação inválida.');
  }
  async own(accountId: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      await this.merchant(tx, accountId, uid);
      const p = await tx.get(profilePath(accountId)),
        settings = await tx.get(root);
      return {
        accountId,
        permissions: permissions(p),
        revision: p?.revision ?? 0,
        kind:
          settings?.supplier_id === accountId && settings.owner_uid === uid
            ? 'owner'
            : p?.products === 'approved' || p?.plans === 'approved'
              ? 'reseller'
              : 'merchant',
      };
    });
  }
  async request(accountId: string, uid: string, raw: unknown) {
    const input = z
      .object({ capability, enabled: z.boolean(), revision: z.number().int().nonnegative() })
      .strict()
      .parse(raw);
    return botTransaction(this.store, async (tx) => {
      const account = await this.merchant(tx, accountId, uid),
        target = profilePath(accountId),
        p = await tx.get(target);
      if ((p?.revision ?? 0) !== input.revision)
        throw new HttpError(409, 'RESALE_CHANGED', 'Atualize as opções de revenda.');
      const next = input.enabled
        ? p?.[input.capability] === 'approved'
          ? 'approved'
          : 'requested'
        : 'none';
      tx.set(target, {
        id: accountId,
        ...permissions(p),
        [input.capability]: next,
        store_name: account.store_name,
        revision: input.revision + 1,
        updated_at: this.now(),
      });
      this.audit(tx, uid, accountId, 'resale.' + input.capability + '.' + next);
      return { ok: true };
    });
  }
  async partners(uid: string) {
    const settings = await this.authority(uid);
    const rows = await this.store.list('merchant_accounts', { limit: 201 });
    const partners = await Promise.all(
      rows.slice(0, 200).map(async (a) => {
        const p = await this.store.get(profilePath(a.id));
        return {
          id: a.id,
          storeName: a.store_name,
          name: a.name,
          accessStatus: a.access_status,
          permissions: permissions(p),
          revision: p?.revision ?? 0,
          kind:
            settings?.supplier_id === a.id
              ? 'owner'
              : p?.products === 'approved' || p?.plans === 'approved'
                ? 'reseller'
                : 'merchant',
        };
      }),
    );
    return { partners, truncated: rows.length > 200 };
  }
  async decide(uid: string, accountId: string, raw: unknown) {
    const input = z
      .object({
        capability,
        status: status.extract(['approved', 'revoked']),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(raw);
    return botTransaction(this.store, async (tx) => {
      await this.authority(uid, tx);
      const target = profilePath(accountId),
        p = await tx.get(target),
        account = await tx.get('merchant_accounts/' + id.parse(accountId));
      if (!account || account.access_status !== 'approved')
        throw new HttpError(409, 'RESELLER_DISABLED', 'A loja precisa ter acesso aprovado.');
      if ((p?.revision ?? 0) !== input.revision)
        throw new HttpError(409, 'RESALE_CHANGED', 'Atualize a lista de revendedores.');
      if (input.status === 'approved' && p?.[input.capability] !== 'requested')
        throw new HttpError(
          409,
          'OPT_IN_REQUIRED',
          'O lojista precisa solicitar esta modalidade primeiro.',
        );
      tx.set(target, {
        id: accountId,
        ...permissions(p),
        [input.capability]: input.status,
        revision: input.revision + 1,
        updated_at: this.now(),
      });
      this.audit(tx, uid, accountId, 'resale.' + input.capability + '.' + input.status);
      return { ok: true };
    });
  }
  async grant(uid: string, raw: unknown) {
    const settings = await this.authority(uid);
    if (!settings)
      throw new HttpError(409, 'GLOBAL_STOCK_NOT_READY', 'Vincule o estoque global primeiro.');
    return new ResaleCatalog(this.store, this.now).grantProduct(settings.supplier_id, uid, raw);
  }
  async offers(accountId: string, uid: string) {
    const own = await this.own(accountId, uid);
    if (own.permissions.products !== 'approved') return { products: [] };
    const settings = await this.store.get(root);
    if (!settings) return { products: [] };
    const rows = await this.store.list(`resale_suppliers/${settings.supplier_id}/grants`, {
      limit: 1000,
      equals: ['partnerId', accountId],
    });
    const catalog = new ResaleCatalog(this.store, this.now);
    const products = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      try {
        products.push(
          await catalog.quoteProduct(
            settings.supplier_id,
            accountId,
            uid,
            row.productId,
            row.baseCents + 1,
          ),
        );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
      }
    }
    return { products: products.map(({ priceCents, ...p }) => p) };
  }
  async publishProduct(accountId: string, uid: string, raw: unknown) {
    const input = z
      .object({
        productId: z.string().regex(/^[a-f0-9]{12}$/),
        priceCents: z.number().int().positive().max(10000000),
      })
      .strict()
      .parse(raw);
    return botTransaction(this.store, async (tx) => {
      await this.merchant(tx, accountId, uid);
      const global = await tx.get(root),
        shop = await tx.get('bot_shops/' + accountId),
        platform = await tx.get('platform_payments/purincash');
      if (!global || !shop || global.supplier_id === accountId)
        throw new HttpError(409, 'SUPPLIER_UNAVAILABLE', 'Fornecedor indisponível.');
      const grant = await tx.get(
          `resale_suppliers/${global.supplier_id}/grants/${accountId}_${input.productId}`,
        ),
        supplier = await tx.get('bot_shops/' + global.supplier_id),
        sourceAccount = await tx.get('merchant_accounts/' + global.supplier_id);
      const product = supplier?.products.find((p: Doc) => p.id === input.productId && p.enabled);
      if (
        !grant?.enabled ||
        !product ||
        sourceAccount?.access_status !== 'approved' ||
        input.priceCents <= grant.baseCents
      )
        throw new HttpError(
          409,
          'SUPPLIER_UNAVAILABLE',
          'Confira o produto e o preço mínimo de revenda.',
        );
      await resaleRecipient(tx, accountId, 'product', platform?.generation, grant.baseCents);
      if (shop.pix_mode !== 'purincash' || shop.payment_mode !== 'manual')
        throw new HttpError(409, 'PURIN_REQUIRED', 'Ative o Pix integrado Blackout nesta loja.');
      const pid = tokenHash(global.supplier_id + ':' + input.productId).slice(0, 12),
        current = shop.products.find((p: Doc) => p.id === pid);
      if (!current && shop.products.length >= 40)
        throw new HttpError(409, 'PRODUCT_LIMIT', 'Limite de produtos atingido.');
      const linked = {
        id: pid,
        title: product.title,
        description: product.description,
        category: product.category,
        price: input.priceCents,
        enabled: true,
        stock: product.stock,
        stock_mode: product.stock_mode ?? 'individual',
        resale_source: { supplierId: global.supplier_id, productId: product.id },
      };
      if (current) shop.products = shop.products.map((p: Doc) => (p.id === pid ? linked : p));
      else {
        shop.products.push(linked);
        tx.set('bot_shops/' + accountId + '/products/' + pid, { id: pid, units: [] });
      }
      tx.set('bot_shops/' + accountId, {
        ...shop,
        portal_revision: (shop.portal_revision ?? 0) + 1,
      });
      this.audit(tx, uid, accountId, 'resale.product_published');
      return { id: pid };
    });
  }
  async commissions(accountId: string, uid: string) {
    await this.own(accountId, uid);
    const rows = await this.store.list('resale_partners/' + accountId + '/commissions', {
      limit: 50,
      orderBy: 'created_at',
    });
    return {
      commissions: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        grossCents: r.grossCents,
        baseCents: r.baseCents,
        gatewayFeeCents: r.gatewayFeeCents,
        partnerCents: r.partnerCents,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  }
  async grants(uid: string) {
    const settings = await this.authority(uid);
    return {
      grants: settings
        ? await this.store.list(`resale_suppliers/${settings.supplier_id}/grants`, { limit: 1000 })
        : [],
    };
  }
}
