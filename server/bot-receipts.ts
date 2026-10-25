import type { Doc, DocumentTransaction } from './document-store.js';
import type { Order, Shop, TelegramMethod, TelegramUpdate } from './bot-types.js';
import { botPath, botButtons } from './bot-data.js';
import { orderSummary, recordPaid, stats } from './bot-orders.js';
import type { SecretVault } from './secret-vault.js';

interface ReceiptContext {
  tx: DocumentTransaction;
  id: string;
  shop: Shop;
  customer: Doc;
  userId: string;
  owner: boolean;
  operational: boolean;
  now: Date;
  message: TelegramUpdate['message'];
  say: (text: string, markup?: ReturnType<typeof botButtons>, target?: string | number) => void;
  emit: (method: TelegramMethod, payload: Record<string, unknown>) => string;
  deliver: (order: Order) => void;
  release: (order: Order, status: 'expired' | 'cancelled' | 'rejected') => Promise<void>;
  audit: (action: string) => void;
}
export class BotReceipts {
  constructor(private vault: SecretVault) {}
  private async read(ctx: ReceiptContext, id: string) {
    return (await ctx.tx.get(botPath(ctx.id, 'orders', id))) as Order | null;
  }
  private revision(ctx: ReceiptContext, order: Order | null, revision: number) {
    if (
      !order ||
      order.payment_method !== 'manual' ||
      order.status !== 'awaiting_review' ||
      order.receipt_revision !== revision ||
      !order.receipt_ciphertext ||
      order.expires_at <= ctx.now
    ) {
      ctx.say(
        'Este comprovante já foi analisado, foi atualizado ou o pedido venceu. Abra a versão atual em Pedidos pendentes.',
      );
      return false;
    }
    return true;
  }
  private showProof(ctx: ReceiptContext, order: Order) {
    if (!order.receipt_ciphertext) return;
    const receipt = JSON.parse(
      this.vault.open(
        order.receipt_ciphertext,
        `${ctx.id}:receipt:${order.id}:${order.receipt_revision}`,
      ),
    );
    const text = `COMPROVANTE PARA CONFERÊNCIA\n\n${orderSummary(order, true)}\n\nConfira o recebimento antes de aprovar.`;
    const markup = botButtons(
      order.status === 'awaiting_review'
        ? [
            [['Aprovar e entregar', `admin:review-approve:${order.id}:${order.receipt_revision}`]],
            [['Recusar', `admin:review-reject:${order.id}:${order.receipt_revision}`]],
          ]
        : [[['Voltar', 'admin:pending']]],
    );
    // Keep the receipt's caption short; all ten product names fit in a separate message.
    ctx.emit(receipt.kind === 'photo' ? 'sendPhoto' : 'sendDocument', {
      chat_id: ctx.shop.owner_id,
      ...(receipt.kind === 'photo' ? { photo: receipt.fileId } : { document: receipt.fileId }),
      caption: `Comprovante do pedido ${order.id} · ${order.buyer_name || order.buyer_id}`.slice(
        0,
        200,
      ),
    });
    ctx.emit('sendMessage', { chat_id: ctx.shop.owner_id, text, reply_markup: markup });
  }
  async action(ctx: ReceiptContext, command: string) {
    if (command.startsWith('receipt:')) {
      const order = await this.read(ctx, command.slice(8));
      if (
        !ctx.operational ||
        !order ||
        order.buyer_id !== ctx.userId ||
        order.payment_method !== 'manual' ||
        !['awaiting_payment', 'awaiting_review'].includes(order.status) ||
        order.expires_at <= ctx.now
      )
        ctx.say(
          'Este pedido não está disponível para envio de comprovante. Confira seu histórico.',
        );
      else {
        ctx.customer.session = { step: 'receipt', order_id: order.id };
        ctx.say(
          `Envie a foto ou arquivo do comprovante referente ao pedido ${order.id}. Ele será encaminhado ao administrador com seu nome e os itens da compra.`,
        );
      }
      return true;
    }
    if (!command.startsWith('admin:review-') && !command.startsWith('admin:proof:')) return false;
    if (!ctx.owner || !ctx.operational) {
      ctx.say('Somente o responsável confirmado pode analisar pagamentos.');
      return true;
    }
    if (command.startsWith('admin:proof:')) {
      const order = await this.read(ctx, command.slice(12));
      if (order?.receipt_ciphertext) this.showProof(ctx, order);
      else ctx.say('Ainda não há comprovante para este pedido.');
      return true;
    }
    const match = /^admin:review-(approve|reject):([a-f0-9]{16}):(\d{1,6})$/.exec(command);
    if (!match) return true;
    const [, action, id, revision] = match,
      order = await this.read(ctx, id);
    if (!this.revision(ctx, order, Number(revision))) return true;
    if (action === 'reject') {
      ctx.customer.session = { step: 'reject_order', order_id: id, revision: Number(revision) };
      ctx.say(
        'Informe o motivo da recusa (3 a 300 caracteres). O comprador receberá esse motivo. /cancelar sai sem recusar.',
      );
    } else {
      order!.status = 'paid';
      order!.reviewed_at = ctx.now;
      order!.reviewed_by = ctx.userId;
      ctx.shop.review_orders = (ctx.shop.review_orders ?? []).filter((v) => v !== id);
      ctx.shop.open_orders = ctx.shop.open_orders.filter((v) => v !== id);
      await recordPaid(ctx.tx, ctx.id, ctx.shop, order!, ctx.now);
      ctx.deliver(order!);
      ctx.tx.set(botPath(ctx.id, 'orders', id), order!);
      ctx.audit('bot_order.manual_payment_approved');
      ctx.say(`Pedido ${id} aprovado. A entrega foi agendada uma única vez.`);
    }
    return true;
  }
  async input(ctx: ReceiptContext, text: string) {
    const session = ctx.customer.session;
    if (session?.step === 'receipt') {
      const order = await this.read(ctx, session.order_id),
        photo = ctx.message?.photo?.at(-1),
        document = ctx.message?.document;
      if (
        !ctx.operational ||
        !order ||
        order.buyer_id !== ctx.userId ||
        order.payment_method !== 'manual' ||
        !['awaiting_payment', 'awaiting_review'].includes(order.status) ||
        order.expires_at <= ctx.now
      ) {
        ctx.customer.session = null;
        ctx.say('O pedido não está mais disponível para envio. Consulte /pedidos.');
      } else if (!photo && !document)
        ctx.say('Envie a foto ou o arquivo do comprovante. Texto sozinho não é um comprovante.');
      else {
        order.receipt_revision = (order.receipt_revision ?? 0) + 1;
        order.receipt_ciphertext = this.vault.seal(
          JSON.stringify({
            kind: photo ? 'photo' : 'document',
            fileId: photo?.file_id ?? document!.file_id,
          }),
          `${ctx.id}:receipt:${order.id}:${order.receipt_revision}`,
        );
        order.status = 'awaiting_review';
        order.expires_at = new Date(ctx.now.getTime() + 86400000);
        ctx.tx.set(botPath(ctx.id, 'orders', order.id), order);
        ctx.shop.review_orders = [...new Set([...(ctx.shop.review_orders ?? []), order.id])];
        ctx.customer.session = null;
        this.showProof(ctx, order);
        ctx.say(
          `Comprovante do pedido ${order.id} enviado. Aguarde a aprovação do administrador. Acompanhe pelo botão Meus pedidos.`,
        );
        ctx.audit('bot_order.receipt_submitted');
      }
      return true;
    }
    if (session?.step !== 'reject_order') return false;
    if (!ctx.owner || !ctx.operational) {
      ctx.customer.session = null;
      ctx.say('Ação indisponível.');
      return true;
    }
    const order = await this.read(ctx, session.order_id);
    if (!this.revision(ctx, order, session.revision)) {
      ctx.customer.session = null;
      return true;
    }
    if (text.length < 3 || text.length > 300) {
      ctx.say('Informe um motivo de 3 a 300 caracteres.');
      return true;
    }
    await ctx.release(order!, 'rejected');
    order!.rejection_reason = text;
    order!.reviewed_at = ctx.now;
    order!.reviewed_by = ctx.userId;
    stats(ctx.shop).rejected_orders++;
    ctx.tx.set(botPath(ctx.id, 'orders', order!.id), order!);
    ctx.customer.session = null;
    ctx.say(
      `Pagamento do pedido ${order!.id} recusado.\nMotivo: ${text}\nConsulte seu histórico ou fale com o suporte.`,
      undefined,
      order!.buyer_id,
    );
    ctx.say('Recusa registrada e comprador avisado. O estoque foi liberado.');
    ctx.audit('bot_order.manual_payment_rejected');
    return true;
  }
}
