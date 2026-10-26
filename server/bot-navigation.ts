import type { BotEffect, TelegramUpdate } from './bot-types.js';

// Only navigation screens are replaced. Invoices, receipts and deliveries remain separate.
export function reuseNavigationMessage(update: TelegramUpdate, effects: BotEffect[]) {
  const callback = update.callback_query,
    message = callback?.message;
  if (
    !message?.message_id ||
    message.chat.type !== 'private' ||
    !/^(home|catalog|cart|clear|support|orders|cat:.*|p:.*|add:.*|remove:.*|order:.*|watch.*|admin|admin:(categories|category:.*|edit|editfor:.*|stock|stockfor:.*|notices|payment|support|welcome|banner|stats|orders|pending|buyers:.*|coupon|new))$/.test(
      callback?.data ?? '',
    )
  )
    return;
  const screen = effects.find(
    (e) =>
      !e.order_id &&
      ['sendMessage', 'sendPhoto'].includes(e.method) &&
      String(e.payload.chat_id) === String(message.chat.id),
  );
  if (!screen) return;
  if (screen.method === 'sendPhoto') {
    const { photo, caption, ...payload } = screen.payload;
    screen.method = 'editMessageMedia';
    screen.payload = {
      ...payload,
      message_id: message.message_id,
      media: { type: 'photo', media: photo, caption },
    };
  } else if (!message.photo?.length) {
    screen.method = 'editMessageText';
    screen.payload.message_id = message.message_id;
  } else {
    // Telegram cannot remove photo media by editing its caption. Replace this screen once.
    const index = effects.indexOf(screen);
    effects.splice(index, 0, {
      id: screen.id + '_old',
      method: 'deleteMessage',
      status: 'pending',
      payload: { chat_id: message.chat.id, message_id: message.message_id },
    });
  }
}
