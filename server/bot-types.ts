import { z } from 'zod';

const telegramUser = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  is_bot: z.boolean().optional(),
  first_name: z.string().max(128).optional(),
});
const file = z.object({ file_id: z.string().min(1).max(512) });
export const telegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      message_id: z.number().int(),
      from: telegramUser.optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      text: z.string().max(4096).optional(),
      document: file.extend({ file_name: z.string().max(256).optional() }).optional(),
      photo: z.array(file).max(20).optional(),
      successful_payment: z
        .object({
          currency: z.string().max(3),
          total_amount: z.number().int().positive(),
          invoice_payload: z.string().max(128),
          telegram_payment_charge_id: z.string().min(1).max(256),
        })
        .optional(),
      refunded_payment: z
        .object({
          currency: z.string().max(3),
          total_amount: z.number().int(),
          invoice_payload: z.string().max(128),
          telegram_payment_charge_id: z.string().min(1).max(256),
        })
        .optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(128),
      from: telegramUser,
      data: z.string().max(64).optional(),
      message: z.object({ chat: z.object({ id: z.number().int(), type: z.string() }) }).optional(),
    })
    .optional(),
  pre_checkout_query: z
    .object({
      id: z.string().max(128),
      from: telegramUser,
      currency: z.string().max(3),
      total_amount: z.number().int().positive(),
      invoice_payload: z.string().max(128),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdate>;
export type TelegramMethod =
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendDocument'
  | 'sendInvoice'
  | 'answerCallbackQuery'
  | 'answerPreCheckoutQuery'
  | 'refundStarPayment';
export interface BotEffect {
  id: string;
  method: TelegramMethod;
  payload: Record<string, unknown>;
  status: 'pending' | 'sending' | 'sent' | 'uncertain';
  order_id?: string;
  delivery?: boolean;
  lease?: string;
}
export interface StockUnit {
  id: string;
  ciphertext: string;
}
export interface Product {
  id: string;
  title: string;
  description: string;
  category: string;
  price: number;
  enabled: boolean;
  stock: number;
}
export interface Shop {
  title: string;
  welcome: string;
  support: string;
  banner: string;
  owner_id: string | null;
  owner_bot_id: string | null;
  products: Product[];
  coupons: Record<string, { percent: number; limit: number; used: number }>;
  recent_orders: string[];
  open_orders: string[];
}
export interface Order {
  id: string;
  buyer_id: string;
  items: { product_id: string; title: string; quantity: number; units: StockUnit[] }[];
  total: number;
  coupon: string;
  created_at: Date;
  expires_at: Date;
  status:
    | 'awaiting_payment'
    | 'precheckout'
    | 'paid'
    | 'delivered'
    | 'cancelled'
    | 'expired'
    | 'refund_required'
    | 'refund_pending'
    | 'refunded';
  charge_id?: string;
  delivery_effects?: string[];
}
export interface RuntimeAccess {
  accountId: string;
  generation: string;
}
