import type { Doc, DocumentTransaction } from './document-store.js';
import type { Order, Shop, ShopStats } from './bot-types.js';
import { botPath } from './bot-data.js';
import { money } from './bot-appearance.js';

export const orderLabels: Record<Order['status'], string> = {
  awaiting_payment: 'Aguardando pagamento',
  precheckout: 'Pagamento em processamento',
  awaiting_review: 'Comprovante aguardando aprovação',
  paid: 'Pagamento aprovado · entrega pendente',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  expired: 'Prazo vencido',
  rejected: 'Pagamento recusado',
  refund_required: 'Pagamento em revisão',
  refund_pending: 'Reembolso em processamento',
  refunded: 'Reembolsado',
};
export function stats(shop: Shop): ShopStats {
  return (
    shop.stats ??
    (shop.stats = {
      orders: 0,
      paid_orders: 0,
      delivered_orders: 0,
      rejected_orders: 0,
      buyers: 0,
      gross_brl: 0,
      gross_stars: 0,
    })
  );
}
export function orderSummary(order: Order, admin = false) {
  return [
    `Pedido ${order.id}`,
    `Estado: ${orderLabels[order.status]}`,
    `Criado em: ${new Date(order.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
    ...(admin
      ? [
          `Cliente: ${order.buyer_name || order.buyer_id}${order.buyer_username ? ' (@' + order.buyer_username + ')' : ''}`,
          `ID Telegram: ${order.buyer_id}`,
        ]
      : []),
    '',
    ...order.items.map((item) => `${item.quantity} × ${item.title}`),
    '',
    `Total: ${money(order.total, order.currency)}`,
    order.rejection_reason ? 'Motivo da recusa: ' + order.rejection_reason : '',
  ]
    .filter(Boolean)
    .join('\n');
}
export async function recordPaid(
  tx: DocumentTransaction,
  id: string,
  shop: Shop,
  order: Order,
  now: Date,
) {
  const target = botPath(id, 'buyers', order.buyer_id),
    buyer = await tx.get(target),
    value = stats(shop);
  if (!buyer) value.buyers++;
  value.paid_orders++;
  if (order.currency === 'BRL') value.gross_brl += order.total;
  else value.gross_stars += order.total;
  tx.set(target, {
    id: order.buyer_id,
    name: order.buyer_name ?? order.buyer_id,
    username: order.buyer_username ?? '',
    paid_orders: (buyer?.paid_orders ?? 0) + 1,
    spent_brl: (buyer?.spent_brl ?? 0) + (order.currency === 'BRL' ? order.total : 0),
    spent_stars: (buyer?.spent_stars ?? 0) + (order.currency !== 'BRL' ? order.total : 0),
    last_purchase: now,
  });
}
export function buyerSummary(buyer: Doc) {
  return `${buyer.name}${buyer.username ? ' (@' + buyer.username + ')' : ''}\nID: ${buyer.id}\nCompras aprovadas: ${buyer.paid_orders}\nTotal: ${money(buyer.spent_brl, 'BRL')} · ${money(buyer.spent_stars, 'XTR')}`;
}
