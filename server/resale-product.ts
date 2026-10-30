import type { DocumentTransaction, Doc } from './document-store.js';
import type { Shop, Product } from './bot-types.js';
import { productGrant } from './resale-grant.js';
import { resaleRecipient } from './resale-finance.js';
import { tokenHash } from './accounts.js';
import { HttpError } from './types.js';
export async function sharedOffer(tx: DocumentTransaction, accountId: string, productId: string) {
  const global = await tx.get('resale_platform/settings');
  if (!global || global.supplier_id === accountId)
    throw new HttpError(409, 'SUPPLIER_UNAVAILABLE', 'Estoque global indisponível.');
  const [supplier, account, profile] = await Promise.all([
    tx.get('bot_shops/' + global.supplier_id),
    tx.get('merchant_accounts/' + global.supplier_id),
    tx.get('resale_profiles/' + accountId),
  ]);
  const product = supplier?.products.find(
    (p: Doc) => p.id === productId && p.enabled && !p.resale_source,
  );
  const grant = await productGrant(tx, global.supplier_id, accountId, productId, product);
  if (
    !product ||
    !grant?.enabled ||
    profile?.products !== 'approved' ||
    account?.access_status !== 'approved'
  )
    throw new HttpError(409, 'SUPPLIER_UNAVAILABLE', 'Produto global ou autorização indisponível.');
  return {
    supplierId: global.supplier_id as string,
    product: product as Product,
    baseCents: grant.baseCents as number,
  };
}
export async function publishSharedProduct(
  tx: DocumentTransaction,
  accountId: string,
  shop: Shop,
  productId: string,
  price: number,
  description?: string,
  banner?: string,
) {
  const offer = await sharedOffer(tx, accountId, productId),
    platform = await tx.get('platform_payments/purincash');
  if (!Number.isSafeInteger(price) || price <= offer.baseCents || price > 10000000)
    throw new HttpError(
      409,
      'SUPPLIER_UNAVAILABLE',
      'O preço deve ser maior que o valor de fornecedor.',
    );
  await resaleRecipient(tx, accountId, 'product', platform?.generation, offer.baseCents);
  if (shop.pix_mode !== 'purincash' || shop.payment_mode !== 'manual')
    throw new HttpError(409, 'PURIN_REQUIRED', 'Ative o Pix integrado Blackout nesta loja.');
  const pid = tokenHash(offer.supplierId + ':' + productId).slice(0, 12),
    current = shop.products.find((p) => p.id === pid);
  if (!current && shop.products.length >= 40)
    throw new HttpError(409, 'PRODUCT_LIMIT', 'Limite de produtos atingido.');
  const linked: Product = {
    id: pid,
    title: offer.product.title,
    category: offer.product.category,
    description: description ?? current?.description ?? offer.product.description,
    banner: banner ?? current?.banner ?? '',
    price,
    enabled: true,
    stock: offer.product.stock,
    stock_mode: offer.product.stock_mode ?? 'individual',
    resale_source: { supplierId: offer.supplierId, productId },
  };
  if (current) shop.products = shop.products.map((p) => (p.id === pid ? linked : p));
  else {
    shop.products.push(linked);
    tx.set('bot_shops/' + accountId + '/products/' + pid, { id: pid, units: [] });
  }
  return linked;
}
