import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Product, Order, Shop } from './bot-types.js';
import type { Doc, DocumentTransaction } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { botPath } from './bot-data.js';
import { stockVersion } from './stock-management.js';
export const modeInput = z
  .object({
    productId: z.string().regex(/^[a-f0-9]{12}$/),
    version: z.string().regex(/^[a-f0-9]{12}$/),
    mode: z.enum(['individual', 'ghost', 'infinite']),
    quantity: z.number().int().min(0).max(1000000).default(0),
    text: z.string().trim().max(1000).default(''),
    sourceUnit: z
      .string()
      .regex(/^(?:[a-f0-9]{16}|template)$/)
      .optional(),
  })
  .strict();
export function syncStock(product: Product, stock: Doc) {
  product.stock_mode = stock.mode ?? 'individual';
  product.stock =
    stock.mode === 'infinite'
      ? stock.template
        ? 1000000
        : 0
      : stock.mode === 'ghost'
        ? (stock.remaining ?? 0)
        : stock.units.length;
}
export async function configureStock(
  tx: DocumentTransaction,
  id: string,
  shop: Shop,
  stock: Doc,
  input: z.infer<typeof modeInput>,
  vault: SecretVault,
  document?: { fileId: string; name: string },
) {
  if (stockVersion(stock) !== input.version)
    throw new HttpError(
      409,
      'STOCK_CHANGED',
      'O estoque mudou. Atualize a lista e tente novamente.',
    );
  const product = shop.products.find((p) => p.id === input.productId);
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
  for (const oid of shop.open_orders) {
    const order = await tx.get(botPath(id, 'orders', oid));
    if (
      order &&
      ['awaiting_payment', 'awaiting_review', 'precheckout'].includes(order.status) &&
      order.items.some((i: Doc) => i.product_id === product.id)
    )
      throw new HttpError(
        409,
        'STOCK_RESERVED',
        'Há pedidos reservados deste produto. Aguarde a conclusão ou o cancelamento para mudar o modo.',
      );
  }
  const source =
    input.sourceUnit === 'template'
      ? stock.template
      : stock.units.find((u: Doc) => u.id === input.sourceUnit);
  if (input.sourceUnit && !source)
    throw new HttpError(409, 'STOCK_CHANGED', 'A unidade escolhida não está disponível.');
  if (input.mode !== 'individual' && !input.text && !source && !document)
    throw new HttpError(
      400,
      'STOCK_TEMPLATE_REQUIRED',
      'Escreva a mensagem que será entregue após o pagamento.',
    );
  stock.mode = input.mode;
  if (input.mode !== 'individual') {
    const unitId = randomBytes(8).toString('hex');
    stock.template = {
      id: unitId,
      ciphertext: vault.seal(
        source
          ? vault.open(source.ciphertext, `${id}:stock:${product.id}:${source.id}`)
          : JSON.stringify(
              document ? { kind: 'document', ...document } : { kind: 'text', text: input.text },
            ),
        `${id}:stock:${product.id}:${unitId}`,
      ),
    };
    stock.remaining = input.quantity;
  }
  syncStock(product, stock);
  tx.set(botPath(id, 'products', product.id), stock);
}
export function reserveUnits(stock: Doc, quantity: number) {
  if (stock.mode === 'ghost' || stock.mode === 'infinite') {
    if (!stock.template || (stock.mode === 'ghost' && stock.remaining < quantity)) return null;
    return Array.from({ length: quantity }, () => ({ ...stock.template }));
  }
  return stock.units.length < quantity ? null : stock.units.slice(0, quantity);
}
export function consumeStock(stock: Doc, item: Order['items'][number]) {
  if (item.stock_mode === 'ghost') stock.remaining -= item.quantity;
  else if (item.stock_mode !== 'infinite') stock.units.splice(0, item.quantity);
}
export function restoreStock(stock: Doc, item: Order['items'][number]) {
  if (item.stock_mode === 'ghost') stock.remaining = (stock.remaining ?? 0) + item.quantity;
  else if (item.stock_mode !== 'infinite') {
    const ids = new Set(stock.units.map((u: Doc) => u.id));
    stock.units.push(...item.units.filter((u) => !ids.has(u.id)));
  }
}
