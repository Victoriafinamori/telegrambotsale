import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Doc, DocumentTransaction } from './document-store.js';
import type { Shop, Product, Order } from './bot-types.js';
import { botRoot, botPath } from './bot-data.js';
import { reserveUnits, consumeStock, restoreStock, syncStock } from './stock-modes.js';
import type { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
export const bundleInput = z
  .array(
    z
      .object({
        productId: z.string().regex(/^[a-f0-9]{12}$/),
        quantity: z.number().int().min(1).max(10),
      })
      .strict(),
  )
  .max(8)
  .refine(
    (rows) =>
      !rows.length ||
      (rows.length >= 2 &&
        new Set(rows.map((r) => r.productId)).size === rows.length &&
        rows.reduce((n, r) => n + r.quantity, 0) <= 20),
    'Escolha de 2 a 8 produtos diferentes, com até 20 unidades no total.',
  );
export function validateBundle(shop: Shop, id: string, rows: Product['bundle']) {
  if (!rows?.length) return;
  bundleInput.parse(rows);
  if (shop.products.some((p) => p.id !== id && p.bundle?.some((r) => r.productId === id)))
    throw new HttpError(
      409,
      'BUNDLE_COMPONENT_INVALID',
      'Este produto já compõe outro combo. Mantenha-o como produto individual.',
    );
  for (const row of rows) {
    const p = shop.products.find((p) => p.id === row.productId);
    if (!p || p.id === id || p.bundle?.length || p.resale_source)
      throw new HttpError(
        409,
        'BUNDLE_COMPONENT_INVALID',
        'Escolha produtos individuais da sua própria loja. Um combo não pode conter outro combo.',
      );
  }
}
export function syncBundles(shop: Shop) {
  for (const p of shop.products.filter((p) => p.bundle?.length)) {
    const parts = p.bundle!.map((r) => ({
      p: shop.products.find((v) => v.id === r.productId),
      q: r.quantity,
    }));
    p.stock = Math.max(
      0,
      Math.min(
        ...parts.map(({ p, q }) =>
          !p?.enabled || p.bundle?.length || p.resale_source
            ? 0
            : p.stock_mode === 'infinite' && p.stock > 0
              ? 1000000
              : Math.floor(p.stock / q),
        ),
      ),
    );
    p.stock_mode =
      parts.every(({ p }) => p?.stock_mode === 'infinite') && p.stock > 0
        ? 'infinite'
        : 'individual';
  }
}
// The planner only consumes private clones. A rejected cart never writes stock.
// All lines, including standalone items and multiple combos, share this planner.
export class StockPlanner {
  private stocks = new Map<string, Promise<Doc | null>>();
  constructor(private tx: DocumentTransaction) {}
  async take(accountId: string, productId: string, quantity: number) {
    const path = botPath(accountId, 'products', productId);
    if (!this.stocks.has(path)) this.stocks.set(path, this.tx.get(path));
    const stock = await this.stocks.get(path);
    const units = stock ? reserveUnits(stock, quantity) : null;
    if (!stock || !units)
      throw new HttpError(
        409,
        'BUNDLE_STOCK_EMPTY',
        'Estoque insuficiente para entregar todos os itens. Nenhum produto foi reservado.',
      );
    const mode = stock.mode ?? 'individual';
    consumeStock(stock, { quantity, stock_mode: mode } as Order['items'][number]);
    return { units, stock_mode: mode as Product['stock_mode'] };
  }
}
export async function reserveBundle(
  tx: DocumentTransaction,
  sourceId: string,
  buyerStore: string,
  p: Product,
  quantity: number,
  vault: SecretVault,
  planner: StockPlanner,
  deliveryProductId = p.id,
) {
  const shop = (await tx.get(botRoot(sourceId))) as Shop | null;
  if (!shop) throw new HttpError(409, 'BUNDLE_UNAVAILABLE', 'Combo indisponível.');
  validateBundle(shop, p.id, p.bundle);
  const sources: NonNullable<Order['items'][number]['bundle_sources']> = [],
    units: Order['items'][number]['units'] = [];
  for (const row of p.bundle ?? []) {
    const component = shop.products.find((v) => v.id === row.productId)!;
    if (!component.enabled)
      throw new HttpError(409, 'BUNDLE_UNAVAILABLE', 'Um dos produtos do combo está indisponível.');
    const reserved = await planner.take(sourceId, component.id, quantity * row.quantity);
    sources.push({
      accountId: sourceId,
      productId: component.id,
      title: component.title,
      quantity: quantity * row.quantity,
      ...reserved,
    });
    for (const u of reserved.units) {
      const key = randomBytes(8).toString('hex'),
        content = JSON.parse(vault.open(u.ciphertext, `${sourceId}:stock:${component.id}:${u.id}`));
      units.push({
        id: key,
        ciphertext: vault.seal(
          JSON.stringify({ ...content, componentTitle: component.title }),
          `${buyerStore}:stock:${deliveryProductId}:${key}`,
        ),
      });
    }
  }
  return {
    product_id: p.id,
    title: p.title,
    quantity,
    units,
    bundle_sources: sources,
    stock_mode: 'individual' as const,
  };
}
export async function changeBundle(
  tx: DocumentTransaction,
  item: Order['items'][number],
  operation: 'consume' | 'restore' | 'finish',
  localId?: string,
  localShop?: Shop,
) {
  for (const src of item.bundle_sources ?? []) {
    const path = botPath(src.accountId, 'products', src.productId),
      stock = await tx.get(path);
    if (!stock) throw Error('Reserved combo component missing');
    if (item.resale_source)
      stock.shared_reserved = Math.max(
        0,
        (stock.shared_reserved ?? 0) + (operation === 'consume' ? src.quantity : -src.quantity),
      );
    if (operation !== 'finish') {
      if (operation === 'consume')
        consumeStock(stock, {
          ...item,
          quantity: src.quantity,
          stock_mode: src.stock_mode,
          units: src.units,
        });
      else
        restoreStock(stock, {
          ...item,
          quantity: src.quantity,
          stock_mode: src.stock_mode,
          units: src.units,
        });
      const shop =
        src.accountId === localId && localShop
          ? localShop
          : ((await tx.get(botRoot(src.accountId))) as Shop);
      const p = shop.products.find((p) => p.id === src.productId);
      if (p) syncStock(p, stock);
      syncBundles(shop);
      if (src.accountId !== localId || !localShop) tx.set(botRoot(src.accountId), shop);
    }
    tx.set(path, stock);
  }
}
