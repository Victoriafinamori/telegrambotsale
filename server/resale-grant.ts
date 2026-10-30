import type { Doc, DocumentTransaction } from './document-store.js';
// Specific grants (including a blocked item) override the approved global catalog.
export async function productGrant(
  tx: DocumentTransaction,
  supplierId: string,
  partnerId: string,
  productId: string,
  product?: Doc,
) {
  const explicit = await tx.get(`resale_suppliers/${supplierId}/grants/${partnerId}_${productId}`);
  if (explicit) return explicit;
  const [settings, profile] = await Promise.all([
    tx.get('resale_platform/settings'),
    tx.get('resale_profiles/' + partnerId),
  ]);
  return settings?.supplier_id === supplierId &&
    profile?.products === 'approved' &&
    product &&
    !product.resale_source &&
    Number.isSafeInteger(product.price) &&
    product.price > 0
    ? { enabled: true, baseCents: product.price, revision: 0 }
    : null;
}
