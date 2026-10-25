import type { Product, Shop } from './bot-types.js';

export function money(amount: number, currency = 'XTR') {
  return currency === 'BRL'
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount / 100)
    : `${amount} ⭐`;
}
export function productText(product: Product, shop?: Shop) {
  return `${product.title}\n${product.description}\n\nPreço: ${money(product.price, shop?.payment_mode === 'manual' ? 'BRL' : 'XTR')}\nDisponíveis: ${product.stock}`;
}
export function parsePrice(text: string, manual: boolean) {
  if (!manual) {
    const n = Number(text);
    return Number.isSafeInteger(n) && n >= 1 && n <= 1000000 ? n : null;
  }
  const match = /^(\d{1,6})(?:[,.](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents >= 1 && cents <= 10000000 ? cents : null;
}
export function supportDetails(shop: Shop) {
  const text = [
    shop.support_name || 'Atendimento da loja',
    shop.support_phone ? `Telefone: ${shop.support_phone}` : '',
    shop.support ? `Telegram: ${shop.support}` : '',
    shop.support_url ? `Link: ${shop.support_url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const url = shop.support_url || (shop.support ? `https://t.me/${shop.support.slice(1)}` : '');
  return { text, url };
}
export function hasSupport(shop: Shop) {
  return Boolean(shop.support || shop.support_phone || shop.support_url);
}
export function supportUrl(text: string) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname.includes('.') &&
      text.length <= 500
      ? url.href
      : null;
  } catch {
    return null;
  }
}
