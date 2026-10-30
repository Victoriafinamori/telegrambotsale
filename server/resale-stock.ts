import { randomBytes } from 'node:crypto';
import type { Doc, DocumentTransaction } from './document-store.js';
import type { Shop, Product, Order } from './bot-types.js';
import { botPath, botRoot } from './bot-data.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { reserveUnits, consumeStock, restoreStock, syncStock } from './stock-modes.js';
import { productGrant } from './resale-grant.js';
export async function refreshSharedCatalog(tx: DocumentTransaction, id: string, shop: Shop) {
  if (!shop.products.some((p) => p.resale_source)) return;
  const profile = await tx.get('resale_profiles/' + id);
  for (const p of shop.products.filter((p) => p.resale_source)) {
    const source = p.resale_source!;
    const [grant, supplier, account] = await Promise.all([
      tx.get(`resale_suppliers/${source.supplierId}/grants/${id}_${source.productId}`),
      tx.get(botRoot(source.supplierId)),
      tx.get('merchant_accounts/' + source.supplierId),
    ]);
    const product = supplier?.products.find((v: Product) => v.id === source.productId && v.enabled);
    const resolved =
      grant ?? (await productGrant(tx, source.supplierId, id, source.productId, product));
    p.stock =
      profile?.products === 'approved' &&
      resolved?.enabled &&
      account?.access_status === 'approved' &&
      product &&
      p.price > resolved.baseCents
        ? product.stock
        : 0;
    p.stock_mode = product?.stock_mode ?? 'individual';
  }
}
export async function reserveShared(
  tx: DocumentTransaction,
  id: string,
  p: Product,
  quantity: number,
  vault: SecretVault,
) {
  const source = p.resale_source!;
  const [grant, supplier, account, profile] = await Promise.all([
    tx.get(`resale_suppliers/${source.supplierId}/grants/${id}_${source.productId}`),
    tx.get(botRoot(source.supplierId)),
    tx.get('merchant_accounts/' + source.supplierId),
    tx.get('resale_profiles/' + id),
  ]);
  const original = supplier?.products.find((v: Product) => v.id === source.productId && v.enabled),
    target = botPath(source.supplierId, 'products', source.productId),
    stock = await tx.get(target);
  const resolved =
    grant ?? (await productGrant(tx, source.supplierId, id, source.productId, original));
  if (
    !original ||
    !stock ||
    !resolved?.enabled ||
    profile?.products !== 'approved' ||
    account?.access_status !== 'approved' ||
    p.price <= resolved.baseCents
  )
    throw new HttpError(409, 'SUPPLIER_UNAVAILABLE', 'Produto do fornecedor indisponível.');
  const selected = reserveUnits(stock, quantity);
  if (!selected) throw new HttpError(409, 'SHARED_STOCK_EMPTY', 'O estoque do fornecedor esgotou.');
  const units = selected.map((u: Doc) => {
    const key = randomBytes(8).toString('hex');
    return {
      id: key,
      ciphertext: vault.seal(
        vault.open(u.ciphertext, `${source.supplierId}:stock:${source.productId}:${u.id}`),
        `${id}:stock:${p.id}:${key}`,
      ),
    };
  });
  const item = {
    product_id: p.id,
    title: p.title,
    quantity,
    units,
    stock_mode: stock.mode ?? 'individual',
    resale_source: { ...source, baseCents: resolved.baseCents, originalUnits: selected },
  } as Order['items'][number];

  return item;
}
export async function restoreShared(tx: DocumentTransaction, item: Order['items'][number]) {
  const source = item.resale_source!;
  const target = botPath(source.supplierId, 'products', source.productId),
    stock = await tx.get(target),
    shop = await tx.get(botRoot(source.supplierId));
  if (!stock || !shop) throw Error('Reserved supplier missing');
  stock.shared_reserved = Math.max(0, (stock.shared_reserved ?? 0) - item.quantity);
  restoreStock(stock, { ...item, units: source.originalUnits });
  const product = shop.products.find((p: Product) => p.id === source.productId);
  if (product) syncStock(product, stock);
  tx.set(target, stock);
  tx.set(botRoot(source.supplierId), shop);
}

export async function consumeShared(tx: DocumentTransaction, item: Order['items'][number]) {
  const source = item.resale_source!,
    target = botPath(source.supplierId, 'products', source.productId),
    stock = await tx.get(target),
    shop = await tx.get(botRoot(source.supplierId));
  if (!stock || !shop) throw Error('Supplier missing');
  stock.shared_reserved = (stock.shared_reserved ?? 0) + item.quantity;
  consumeStock(stock, item);
  const product = shop.products.find((p: Product) => p.id === source.productId);
  if (product) syncStock(product, stock);
  tx.set(target, stock);
  tx.set(botRoot(source.supplierId), shop);
}

export async function finishShared(tx: DocumentTransaction, item: Order['items'][number]) {
  const source = item.resale_source!;
  const target = botPath(source.supplierId, 'products', source.productId),
    stock = await tx.get(target);
  if (stock) {
    stock.shared_reserved = Math.max(0, (stock.shared_reserved ?? 0) - item.quantity);
    tx.set(target, stock);
  }
}
