import type { BotEffect, TelegramUpdate } from './bot-types.js';

// Read-only buyer screens can return their leased replies in the update response.
// Checkout, stock changes and private owner commands keep the normal outbox path.
export const fastNavigation = (data?: string) =>
  /^(home|catalog|cart|orders|support|cat:[a-f0-9]{16}|p:[a-f0-9]{12,36})$/.test(data ?? '');

// Only navigation screens are replaced. Invoices, receipts and deliveries remain separate.
export function reuseNavigationMessage(update: TelegramUpdate, effects: BotEffect[]) {
  const callback = update.callback_query,
    message = callback?.message;
  if (
    !message?.message_id ||
    message.chat.type !== 'private' ||
    !/^(home|catalog|cart|clear|support|orders|cat:.*|p:.*|add:.*|remove:.*|order:.*|watch.*|wallet:(history|new|type:.*|status:.*)|admin|admin:(wallet|subscription|categories|category:.*|edit|editfor:.*|stock|stockfor:.*|notices|payment|support|welcome|banner|stats|orders|pending|buyers:.*|coupon|new))$/.test(
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
