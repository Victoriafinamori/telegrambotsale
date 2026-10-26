import type { MercadoPagoPayments } from './mercado-pago.js';
import { checkoutInput } from './mercado-pago.js';
import type { PurinCashPayments } from './purin-cash.js';
import { botPath } from './bot-data.js';
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
}
