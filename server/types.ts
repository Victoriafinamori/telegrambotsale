export interface Result<T = Record<string, unknown>> {
  rows: T[];
}
export interface Connection {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Result<T>>;
}
export interface Database extends Connection {
  transaction<T>(fn: (db: Connection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface Identity {
  uid: string;
  email: string;
  emailVerified: boolean;
  authTime: number;
  secondFactor?: boolean;
}
export interface IdentityProvider {
  verifyIdToken(token: string): Promise<Identity>;
  createSession(token: string, expiresIn: number): Promise<string>;
  verifySession(cookie: string): Promise<Identity>;
}
export type Channel = 'whatsapp' | 'telegram' | 'discord' | 'site' | 'other';
export interface MerchantAccount {
  id: string;
  name: string;
  email: string;
  store_name: string;
  channel: Channel;
  reference: string;
  price_cents: number;
  firebase_uid: string | null;
  purchase_confirmed_at: Date | null;
  access_status: 'pending' | 'approved' | 'suspended';
  created_at: Date;
  approved_at: Date | null;
  suspension_reason: string | null;
  billing_started_at: Date | null;
  paid_through: Date | null;
}
export interface AdminMerchantAccount extends MerchantAccount {
  bot_username: string | null;
  bot_activation_status: 'pending' | 'configuring' | 'changes_requested' | 'active' | null;
  bot_submitted_at: Date | null;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
