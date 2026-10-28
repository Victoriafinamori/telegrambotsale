import QRCode from 'qrcode';
import type { Order } from './bot-types.js';
import { money } from './bot-appearance.js';

export const pixCaption = (order: Order) =>
  [
    '💠 PAGUE COM PIX',
    '',
    ...order.items.slice(0, 4).map((item) => `${item.quantity} × ${item.title.slice(0, 70)}`),
    ...(order.items.length > 4 ? [`+ ${order.items.length - 4} itens no pedido`] : []),
    '',
    `💰 ${money(order.total, 'BRL')}`,
    `⏳ Válido até ${order.expires_at.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`,
    '',
    'Escaneie o QR Code ou use o Pix copia e cola.',
    'Confira o valor e o recebedor no aplicativo do banco.',
    'A entrega será liberada automaticamente após a confirmação.',
    '',
    `Pedido #${order.id}`,
  ].join('\n');

export async function pixPhoto(code: string) {
  // Always encode the authoritative BR Code locally; never fetch remote images.
  return QRCode.toDataURL(code, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 768,
  });
}
