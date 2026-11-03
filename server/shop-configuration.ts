import { z } from 'zod';
import type { Product, Shop } from './bot-types.js';
import type { NavigationSnapshot } from './local-navigation.js';
import { HttpError } from './types.js';
import { tokenHash } from './accounts.js';

const media = z
  .string()
  .max(512)
  .refine(
    (value) =>
      !value ||
      /^[A-Za-z0-9_-]+$/.test(value) ||
      (() => {
        try {
          const u = new URL(value);
          return u.protocol === 'https:' && !u.username && !u.password;
        } catch {
          return false;
        }
      })(),
  );
const productId = z.string().regex(/^[a-f0-9]{12,36}$/);
export const shopConfigurationChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('welcome'), value: z.string().trim().min(1).max(600) }).strict(),
  z.object({ kind: z.literal('banner'), value: media }).strict(),
  z.object({ kind: z.literal('support_name'), value: z.string().trim().max(70) }).strict(),
  z.object({ kind: z.literal('support_phone'), value: z.string().trim().max(40) }).strict(),
  z
    .object({
      kind: z.literal('support'),
      value: z.string().refine((v) => v === '' || /^@[A-Za-z0-9_]{5,32}$/.test(v)),
    })
    .strict(),
  z
    .object({
      kind: z.literal('support_url'),
      value: z
        .string()
        .max(500)
        .refine(
          (v) =>
            !v ||
            (() => {
              try {
                const u = new URL(v);
                return u.protocol === 'https:' && !u.username && !u.password;
              } catch {
                return false;
              }
            })(),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('product_description'),
      productId,
      value: z.string().trim().min(1).max(400),
    })
    .strict(),
  z.object({ kind: z.literal('product_banner'), productId, value: media }).strict(),
  z
    .object({
      kind: z.literal('product_price'),
      productId,
      value: z.number().int().min(1).max(10000000),
    })
    .strict(),
]);
export type ShopConfigurationChange = z.infer<typeof shopConfigurationChange>;
export const configurationCommit = z
  .object({
    mutationId: z.uuid(),
    ownerId: z.string().regex(/^\d{1,16}$/),
    generation: z.string().min(1).max(80),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    change: shopConfigurationChange,
  })
  .strict();
export interface LocalConfigurationSnapshot extends NavigationSnapshot {
  revision: string;
  generation: string;
  ownerVerified: true;
}
export function shopConfigurationVersion(shop: Shop) {
  return tokenHash(
    JSON.stringify({
      title: shop.title,
      welcome: shop.welcome,
      banner: shop.banner,
      support: shop.support,
      support_name: shop.support_name ?? '',
      support_phone: shop.support_phone ?? '',
      support_url: shop.support_url ?? '',
      payment_mode: shop.payment_mode,
      products: shop.products.map((p) => ({
        id: p.id,
        title: p.title,
        category: p.category,
        enabled: p.enabled,
        description: p.description,
        banner: p.banner ?? '',
        price: p.price,
      })),
    }),
  );
}
export function applyShopConfiguration(shop: Shop, change: ShopConfigurationChange) {
  const next = structuredClone(shop);
  if ('productId' in change) {
    const product = next.products.find((p) => p.id === change.productId);
    if (!product)
      throw new HttpError(409, 'PRODUCT_CHANGED', 'O produto foi removido. Atualize a loja.');
    const field = {
      product_description: 'description',
      product_banner: 'banner',
      product_price: 'price',
    }[change.kind] as keyof Product;
    Object.assign(product, { [field]: change.value });
  } else Object.assign(next, { [change.kind]: change.value });
  return next;
}
