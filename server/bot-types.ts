import { z } from 'zod';

const telegramUser = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  is_bot: z.boolean().optional(),
  first_name: z.string().max(128).optional(),
  last_name: z.string().max(128).optional(),
  username: z.string().max(64).optional(),
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
  status: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed' | 'skipped';
  order_id?: string;
  delivery?: boolean;
  lease?: string;
  announcement_id?: string;
  recipient_id?: string;
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
  banner?: string;
  pix_qr?: string;
  pix_qr_price?: number;
}
export interface Shop {
  portal_revision?: number;
  title: string;
  welcome: string;
  support: string;
  support_name?: string;
  support_phone?: string;
  support_url?: string;
  banner: string;
  owner_id: string | null;
  owner_bot_id: string | null;
  products: Product[];
  categories?: string[];
  coupons: Record<string, { percent: number; limit: number; used: number }>;
  recent_orders: string[];
  open_orders: string[];
  notice_subscribers?: number;
  notice_recent?: string[];
  notice_active?: string | null;
  payment_mode?: 'manual' | 'stars';
  payment_instructions?: string;
  pix_mode?: 'manual' | 'mercadopago';
  pix_keys?: {
    type: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';
    value: string;
    holder: string;
  }[];
  mp_connection?: string;
  review_orders?: string[];
  stats?: ShopStats;
}
export interface ShopStats {
  orders: number;
  paid_orders: number;
  delivered_orders: number;
  rejected_orders: number;
  buyers: number;
  gross_brl: number;
  gross_stars: number;
}
export interface Announcement {
  id: string;
  text: string;
  photo: string;
  status: 'draft' | 'queued' | 'sending' | 'completed' | 'cancelled';
  created_at: Date;
  audience_at: Date | null;
  cursor: string;
  scan_complete: boolean;
  queued: number;
  sent: number;
  failed: number;
  uncertain: number;
  skipped: number;
}
export interface Order {
  id: string;
  buyer_id: string;
  buyer_name?: string;
  buyer_username?: string;
  currency?: 'BRL' | 'XTR';
  payment_method?: 'manual' | 'stars' | 'mercadopago';
  checkout_token_hash?: string;
  mp_connection?: string;
  mp_payment_id?: string;
  items: { product_id: string; title: string; quantity: number; units: StockUnit[] }[];
  total: number;
  coupon: string;
  created_at: Date;
  expires_at: Date;
  status:
    | 'awaiting_payment'
    | 'precheckout'
    | 'awaiting_review'
    | 'rejected'
    | 'paid'
    | 'delivered'
    | 'cancelled'
    | 'expired'
    | 'refund_required'
    | 'refund_pending'
    | 'refunded';
  charge_id?: string;
  delivery_effects?: string[];
  receipt_ciphertext?: string;
  receipt_revision?: number;
  reviewed_at?: Date;
  reviewed_by?: string;
  rejection_reason?: string;
  fulfilled_at?: Date;
}
export interface RuntimeAccess {
  accountId: string;
  generation: string;
}
