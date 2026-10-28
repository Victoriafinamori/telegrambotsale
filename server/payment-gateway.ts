import type { MercadoPagoPayments } from './mercado-pago.js';
import { checkoutInput } from './mercado-pago.js';
import type { PurinCashPayments } from './purin-cash.js';
import { botPath } from './bot-data.js';
import type { RuntimeAccess } from './bot-types.js';
import { HttpError } from './types.js';
// The stored order selects its provider. A browser cannot change the recipient/provider.
export class PaymentGateway {
  constructor(
    readonly mp: MercadoPagoPayments,
    readonly purin: PurinCashPayments,
  ) {}
  private async select(raw: unknown) {
    const { payer: _payer, ...base } =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const input = checkoutInput.parse(base);
    const order = await this.mp.store.get(botPath(input.accountId, 'orders', input.orderId));
    return order?.payment_method === 'purincash' ? this.purin : this.mp;
  }
  async details(raw: unknown) {
    return (await this.select(raw)).details(raw);
  }
  async create(raw: unknown) {
    return (await this.select(raw)).create(raw);
  }
  async refresh(raw: unknown) {
    return (await this.select(raw)).refresh(raw);
  }
  async checkFromBot(id: string, buyer: string, oid: string) {
    const order = await this.mp.store.get(botPath(id, 'orders', oid));
    return (order?.payment_method === 'purincash' ? this.purin : this.mp).checkFromBot(
      id,
      buyer,
      oid,
    );
  }
  async createFromBot(auth: RuntimeAccess, buyer: string, oid: string) {
    let base;
    try {
      base = await this.mp.bots.checkoutForBot(auth, buyer, oid);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return [];
      throw error;
    }
    try {
      const charge = await this.purin.create(base);
      return this.mp.bots.queuePix(auth, buyer, oid, charge.qrCode || undefined);
    } catch (error) {
      return this.mp.bots.queuePix(
        auth,
        buyer,
        oid,
        undefined,
        error instanceof HttpError
          ? error.message
          : 'A cobrança está em conferência. Use Verificar pagamento. Não pague duas vezes.',
      );
    }
  }
}
