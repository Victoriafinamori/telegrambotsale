import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DocumentStore, DocumentTransaction, Doc } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { BotStore } from './bot-store.js';
import { botPath, botRoot, botTransaction } from './bot-data.js';
import { TestDocumentStore, encodeTestState, decodeTestState } from './test-document-store.js';
import { HttpError } from './types.js';
import type { Shop, Order, Product, TelegramUpdate, BotEffect } from './bot-types.js';

const buyer = 900000001,
  owner = 900000002;
const sessionPath = (id: string) => 'merchant_test_sessions/' + id;
export type TestMessage = {
  id: number;
  audience: 'buyer' | 'owner';
  kind: 'text' | 'photo' | 'file' | 'invoice';
  text: string;
  asset?: string;
  buttons: { label: string; data: string }[];
  delivery: boolean;
  turn?: number;
};
type State = {
  records: Record<string, Doc>;
  messages: TestMessage[];
  sequence: number;
  messageSequence: number;
  mode: string;
  deliveryKind: 'code' | 'file';
  generation: string;
  actions: number;
};
const startInput = z
  .object({ requestId: z.uuid(), deliveryKind: z.enum(['code', 'file']) })
  .strict();
const actionInput = z
  .object({
    sessionId: z.uuid(),
    revision: z.number().int().nonnegative(),
    requestId: z.uuid(),
    action: z.enum(['button', 'text', 'receipt', 'approve', 'reject', 'restock']),
    value: z.string().max(200).default(''),
    messageId: z.number().int().positive().optional(),
  })
  .strict();
const safeCallback =
  /^(home|catalog|cart|clear|support|orders|coupon|cat:[a-f0-9]+|p:[a-f0-9]{12}|add:[a-f0-9]{12}|remove:[a-f0-9]{12}|buy:[a-f0-9]{12}|checkout|order:[a-f0-9]{16}|history:[A-Za-z0-9_-]*|cancel:[a-f0-9]{16}|receipt:[a-f0-9]{16}|watch(?:-on|-off)?:[a-f0-9]{12})$/;

export class StoreTest {
  private vault: SecretVault;
  constructor(
    private store: DocumentStore,
    private key: string,
    private now = () => new Date(),
  ) {
    this.vault = new SecretVault(key);
  }
  private async own(tx: DocumentTransaction, id: string, uid: string) {
    const account = await tx.get('merchant_accounts/' + id),
      shop = await tx.get(botRoot(id));
    if (!account || account.firebase_uid !== uid || account.access_status !== 'approved')
      throw new HttpError(
        403,
        'TEST_OWNER_REQUIRED',
        'O teste está disponível apenas para o lojista desta conta.',
      );
    if (!shop)
      throw new HttpError(
        409,
        'TEST_STORE_MISSING',
        'Conecte seu bot e prepare a loja antes de iniciar o teste.',
      );
    return shop as Shop;
  }
  private open(id: string, doc: Doc): State {
    return decodeTestState(
      JSON.parse(this.vault.open(doc.ciphertext, 'store-test:' + id + ':' + doc.id)),
    );
  }
  private save(tx: DocumentTransaction, id: string, doc: Doc, state: State) {
    const json = JSON.stringify(encodeTestState(state));
    if (Buffer.byteLength(json) > 550000)
      throw new HttpError(
        409,
        'TEST_SESSION_FULL',
        'Esta simulação atingiu o limite. Inicie um novo teste.',
      );
    tx.set(sessionPath(id), {
      ...doc,
      ciphertext: this.vault.seal(json, 'store-test:' + id + ':' + doc.id),
    });
  }
  private view(id: string, doc: Doc, state: State) {
    const shop = state.records[botRoot(id)] as Shop;
    const orders = shop.recent_orders
      .map((orderId) => state.records[botPath(id, 'orders', orderId)])
      .filter(Boolean)
      .map((row) => ({
        id: row.id,
        status: row.status,
        total: row.total,
        currency: row.currency,
        items: (row.items as Order['items']).map((item) => ({
          title: item.title,
          quantity: item.quantity,
        })),
        receipt: Boolean(row.receipt_ciphertext),
      }));
    return {
      id: doc.id as string,
      revision: doc.revision as number,
      expiresAt: (doc.expires_at as Date).toISOString(),
      createdAt: (doc.created_at as Date).toISOString(),
      mode: state.mode,
      deliveryKind: state.deliveryKind,
      messages: state.messages,
      products: shop.products.map((p) => ({
        id: p.id,
        title: p.title,
        stock: p.stock,
        enabled: p.enabled,
      })),
      orders,
      actionsLeft: 60 - state.actions,
      simulated: true as const,
    };
  }
  async read(id: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      await this.own(tx, id, uid);
      const doc = await tx.get(sessionPath(id));
      return {
        session: doc && doc.expires_at > this.now() ? this.view(id, doc, this.open(id, doc)) : null,
      };
    });
  }
  private unit(id: string, product: Product, index: number, kind: State['deliveryKind']) {
    const key = randomUUID().replaceAll('-', '').slice(0, 12);
    const content =
      kind === 'file'
        ? { kind: 'document', fileId: 'BLACKOUT_TEST_FILE' }
        : {
            kind: 'text',
            text: `BLACKOUT-TESTE-${product.id}-${index}\nConteúdo fictício. Não é um produto real.`,
          };
    return {
      id: key,
      ciphertext: this.vault.seal(JSON.stringify(content), `${id}:stock:${product.id}:${key}`),
    };
  }
  async start(id: string, uid: string, raw: unknown) {
    const input = startInput.parse(raw);
    return botTransaction(this.store, async (tx) => {
      const source = await this.own(tx, id, uid),
        existing = await tx.get(sessionPath(id));
      if (existing?.start_request_id === input.requestId && existing.expires_at > this.now())
        return this.view(id, existing, this.open(id, existing));
      const generation = randomUUID(),
        sandbox = new TestDocumentStore();
      const products = source.products.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        category: p.category,
        enabled: p.enabled,
        price: p.price,
        stock: Math.min(10, Math.max(0, p.stock)),
        banner: p.banner ?? '',
      }));
      const shop: Shop = {
        title: source.title,
        welcome: source.welcome,
        banner: source.banner,
        support: source.support,
        support_name: source.support_name ?? '',
        support_phone: source.support_phone ?? '',
        support_url: source.support_url ?? '',
        owner_id: String(owner),
        owner_bot_id: '999999999',
        categories: source.categories ?? [],
        category_emojis: source.category_emojis ?? {},
        products,
        coupons: structuredClone(source.coupons),
        recent_orders: [],
        open_orders: [],
        review_orders: [],
        payment_mode: source.payment_mode === 'stars' ? 'stars' : 'manual',
        pix_mode: 'manual',
        payment_instructions:
          '[SIMULAÇÃO] Nenhum Pix ou transferência deve ser feito. Use os controles de pagamento fictício no painel.',
      };
      sandbox.records['merchant_accounts/' + id] = {
        id,
        firebase_uid: uid,
        access_status: 'approved',
        purchase_confirmed_at: this.now(),
        paid_through: new Date(this.now().getTime() + 86400000),
      };
      sandbox.records['merchant_bot_setup/' + id] = {
        bot_id: '999999999',
        bot_username: 'BlackoutSimulationBot',
        telegram_user_id: String(owner),
        submitted_at: this.now(),
        activation_status: 'active',
      };
      sandbox.records['bot_runtimes/' + id] = {
        generation,
        bot_id: '999999999',
        revoked: false,
        offset: 0,
      };
      sandbox.records[botRoot(id)] = shop;
      for (const product of products)
        sandbox.records[botPath(id, 'products', product.id)] = {
          units: Array.from({ length: product.stock }, (_, i) =>
            this.unit(id, product, i + 1, input.deliveryKind),
          ),
        };
      const state: State = {
        records: sandbox.records,
        messages: [],
        sequence: 0,
        messageSequence: 0,
        mode: source.payment_mode === 'stars' ? 'stars' : (source.pix_mode ?? 'manual'),
        deliveryKind: input.deliveryKind,
        generation,
        actions: 0,
      };
      const doc = {
        id: randomUUID(),
        revision: 0,
        start_request_id: input.requestId,
        created_at: this.now(),
        expires_at: new Date(this.now().getTime() + 2 * 3600000),
      };
      await this.update(id, state, sandbox, '/start');
      this.save(tx, id, doc, state);
      return this.view(id, doc, state);
    });
  }
  private async update(
    id: string,
    state: State,
    sandbox: TestDocumentStore,
    text: string,
    actor = buyer,
    callback = false,
    messageId?: number,
    document = false,
    payment?: Order,
  ) {
    const bots = new BotStore(sandbox, this.key, this.now),
      auth = { accountId: id, generation: state.generation };
    const sequence = ++state.sequence;
    const update: TelegramUpdate = callback
      ? {
          update_id: sequence,
          callback_query: {
            id: 'test' + sequence,
            from: {
              id: actor,
              first_name: actor === buyer ? 'Comprador de teste' : 'Lojista de teste',
            },
            data: text,
            message: {
              message_id: messageId,
              chat: { id: actor, type: 'private' },
              ...(messageId && state.messages.find((m) => m.id === messageId)?.kind === 'photo'
                ? { photo: [{ file_id: 'TEST_PHOTO' }] }
                : {}),
            },
          },
        }
      : {
          update_id: sequence,
          message: {
            message_id: sequence,
            from: { id: actor, first_name: 'Comprador de teste' },
            chat: { id: actor, type: 'private' },
            ...(document
              ? { document: { file_id: 'BLACKOUT_TEST_RECEIPT' } }
              : payment
                ? {
                    successful_payment: {
                      currency: 'XTR',
                      total_amount: payment.total,
                      invoice_payload: payment.id,
                      telegram_payment_charge_id: 'TEST_' + payment.id,
                    },
                  }
                : { text }),
          },
        };
    const result = await bots.process(auth, update);
    for (const effectId of result.effectIds) {
      const effect = await bots.claim(auth, effectId);
      if (!effect) continue;
      this.capture(state, effect);
      await bots.acknowledge(auth, effect.id, effect.lease, 'sent');
    }
  }
  private capture(state: State, effect: BotEffect) {
    const p = effect.payload,
      audience = String(p.chat_id) === String(owner) ? 'owner' : 'buyer';
    if (effect.method === 'deleteMessage') {
      state.messages = state.messages.filter((m) => m.id !== p.message_id);
      return;
    }
    if (
      ![
        'sendMessage',
        'sendPhoto',
        'sendDocument',
        'sendInvoice',
        'editMessageText',
        'editMessageMedia',
      ].includes(effect.method)
    )
      return;
    const media = p.media as Doc | undefined;
    const kind =
      effect.method === 'sendDocument'
        ? 'file'
        : effect.method === 'sendInvoice'
          ? 'invoice'
          : effect.method === 'sendPhoto' || media
            ? 'photo'
            : 'text';
    const buttons = ((p.reply_markup as Doc | undefined)?.inline_keyboard ?? [])
      .flat()
      .filter(
        (button: Doc) =>
          typeof button.callback_data === 'string' && safeCallback.test(button.callback_data),
      )
      .map((button: Doc) => ({ label: String(button.text), data: button.callback_data }));
    const message: TestMessage = {
      turn: state.sequence,
      id: effect.method.startsWith('edit') ? Number(p.message_id) : ++state.messageSequence,
      audience,
      kind,
      text: String(
        p.text ??
          p.caption ??
          media?.caption ??
          (kind === 'invoice'
            ? 'Fatura Stars simulada. Nenhum pagamento será solicitado ao Telegram.'
            : 'Comprovante fictício para conferência.'),
      ),
      buttons,
      delivery: effect.delivery === true,
      ...(kind === 'photo' &&
      /^[A-Za-z0-9_-]+$/.test(String(p.photo ?? media?.media)) &&
      String(p.photo ?? media?.media) !== 'BLACKOUT_TEST_RECEIPT'
        ? { asset: String(p.photo ?? media?.media) }
        : {}),
    };
    const existing = state.messages.findIndex(
      (m) => m.id === message.id && m.audience === audience,
    );
    if (existing >= 0) state.messages[existing] = message;
    else state.messages.push(message);
    state.messages = state.messages.slice(-100);
  }
  async action(id: string, uid: string, raw: unknown) {
    const input = actionInput.parse(raw);
    return botTransaction(this.store, async (tx) => {
      await this.own(tx, id, uid);
      const doc = await tx.get(sessionPath(id));
      if (!doc || doc.id !== input.sessionId || doc.expires_at <= this.now())
        throw new HttpError(
          410,
          'TEST_EXPIRED',
          'Este teste venceu ou foi substituído. Inicie uma nova simulação.',
        );
      const state = this.open(id, doc);
      if (doc.last_request_id === input.requestId) return this.view(id, doc, state);
      if (doc.revision !== input.revision)
        throw new HttpError(
          409,
          'TEST_CHANGED',
          'O teste mudou em outra aba. Use Retomar teste para atualizar.',
        );
      if (state.actions >= 60)
        throw new HttpError(
          409,
          'TEST_SESSION_FULL',
          'Esta simulação atingiu o limite. Inicie um novo teste.',
        );
      const sandbox = new TestDocumentStore(state.records),
        shop = sandbox.records[botRoot(id)] as Shop;
      const orders = shop.recent_orders.map(
        (orderId) => sandbox.records[botPath(id, 'orders', orderId)] as Order,
      );
      const order = orders.find((order) =>
        ['awaiting_payment', 'precheckout', 'awaiting_review'].includes(order.status),
      );
      if (input.action === 'button') {
        if (
          !safeCallback.test(input.value) ||
          !state.messages.some(
            (m) =>
              m.audience === 'buyer' &&
              m.id === input.messageId &&
              m.buttons.some((button) => button.data === input.value),
          )
        )
          throw new HttpError(
            400,
            'TEST_ACTION_INVALID',
            'Use um botão disponível na conversa de teste.',
          );
        await this.update(id, state, sandbox, input.value, buyer, true, input.messageId);
      } else if (input.action === 'text') {
        const value = input.value.trim();
        if (
          !value ||
          (value.startsWith('/') &&
            !['/start', '/pedidos', '/suporte', '/cancelar'].includes(value))
        )
          throw new HttpError(
            400,
            'TEST_ACTION_INVALID',
            'Use os comandos de comprador ou um código de cupom.',
          );
        await this.update(id, state, sandbox, value);
      } else if (input.action === 'restock') {
        const product = shop.products.find((p) => p.id === input.value);
        if (!product || product.stock >= 10)
          throw new HttpError(
            400,
            'TEST_STOCK_INVALID',
            'Escolha um produto com menos de dez unidades de teste.',
          );
        const stock = sandbox.records[botPath(id, 'products', product.id)];
        stock.units.push(this.unit(id, product, stock.units.length + 1, state.deliveryKind));
        product.stock = stock.units.length;
      } else {
        if (!order)
          throw new HttpError(
            409,
            'TEST_ORDER_MISSING',
            'Crie um pedido na conversa de teste primeiro.',
          );
        if (state.mode === 'stars') {
          if (input.action !== 'approve')
            throw new HttpError(
              400,
              'TEST_ACTION_INVALID',
              'Neste teste Stars, use Simular pagamento aprovado.',
            );
          await this.update(id, state, sandbox, '', buyer, false, undefined, false, order);
        } else {
          if (!order.receipt_ciphertext) {
            await this.update(id, state, sandbox, 'receipt:' + order.id, buyer, true);
            await this.update(id, state, sandbox, '', buyer, false, undefined, true);
          }
          const current = sandbox.records[botPath(id, 'orders', order.id)] as Order;
          if (input.action === 'approve' || input.action === 'reject') {
            await this.update(
              id,
              state,
              sandbox,
              `admin:review-${input.action === 'approve' ? 'approve' : 'reject'}:${order.id}:${current.receipt_revision}`,
              owner,
              true,
            );
            if (input.action === 'reject')
              await this.update(
                id,
                state,
                sandbox,
                'Recusa simulada: pagamento de teste não aprovado.',
                owner,
              );
          }
        }
      }
      state.actions++;
      const next = { ...doc, revision: doc.revision + 1, last_request_id: input.requestId };
      this.save(tx, id, next, state);
      return this.view(id, next, state);
    });
  }
}
