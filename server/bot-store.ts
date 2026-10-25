import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { tokenHash } from './accounts.js';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { nextBillingMonth } from './billing-period.js';
import {
  telegramUpdate,
  type TelegramUpdate,
  type RuntimeAccess,
  type Shop,
  type Order,
  type Product,
  type BotEffect,
  type StockUnit,
  type TelegramMethod,
} from './bot-types.js';

const root = (id: string) => 'bot_shops/' + id;
const path = (id: string, kind: string, key: string) =>
  root(id) +
  '/' +
  kind +
  '/' +
  (/^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : 'invalid_' + tokenHash(key));
const unavailable = () =>
  new HttpError(403, 'BOT_RUNTIME_UNAVAILABLE', 'A operação deste bot está indisponível.');
const isoMoney = (amount: number) => `${amount} ⭐`;
const buttons = (rows: [string, string][][]) => ({
  inline_keyboard: rows.map((row) => row.map(([text, callback_data]) => ({ text, callback_data }))),
});
const isOpen = (order: Order) => ['awaiting_payment', 'precheckout'].includes(order.status);

// Writes are deferred until every read finishes: Firestore does not allow reads after writes.
async function buffered<T>(store: DocumentStore, work: (tx: DocumentTransaction) => Promise<T>) {
  return store.transaction(async (raw) => {
    const writes = new Map<string, Doc | null>();
    const tx: DocumentTransaction = {
      get: async (key) => (writes.has(key) ? structuredClone(writes.get(key)!) : raw.get(key)),
      set: (key, value) => {
        writes.set(key, structuredClone(value));
      },
      delete: (key) => {
        writes.set(key, null);
      },
    };
    const result = await work(tx);
    for (const [key, value] of writes) value === null ? raw.delete(key) : raw.set(key, value);
    return result;
  });
}

export class BotStore {
  private vault: SecretVault;
  constructor(
    readonly store: DocumentStore,
    key: string,
    readonly now: () => Date = () => new Date(),
  ) {
    this.vault = new SecretVault(key);
  }

  private async lifecycle(tx: DocumentTransaction, id: string) {
    const account = await tx.get('merchant_accounts/' + id),
      setup = await tx.get('merchant_bot_setup/' + id);
    if (!account || !setup?.submitted_at || !account.firebase_uid || !account.purchase_confirmed_at)
      throw unavailable();
    return { account, setup };
  }
  private initial(title: string): Shop {
    return {
      title,
      welcome: 'Escolha um produto para começar.',
      support: '',
      banner: '',
      owner_id: null,
      owner_bot_id: null,
      products: [],
      coupons: {},
      recent_orders: [],
      open_orders: [],
    };
  }

  async provision(accountId: string, applicationId: string) {
    const secret = randomBytes(32).toString('base64url'),
      generation = randomUUID();
    await buffered(this.store, async (tx) => {
      const { account, setup } = await this.lifecycle(tx, accountId);
      if (
        account.access_status !== 'approved' ||
        !['configuring', 'active'].includes(setup.activation_status)
      )
        throw unavailable();
      if (setup.deployment_reference && setup.deployment_reference !== applicationId)
        throw new HttpError(
          409,
          'APP_BINDING_CHANGED',
          'O aplicativo precisa corresponder à ativação registrada.',
        );
      const link = await tx.get('bot_runtime_apps/' + tokenHash(applicationId));
      if (link && link.account_id !== accountId)
        throw new HttpError(409, 'APP_ALREADY_BOUND', 'Aplicativo vinculado a outra loja.');
      const shop = await tx.get(root(accountId));
      tx.set('bot_runtimes/' + accountId, {
        account_id: accountId,
        application_id: applicationId,
        secret_hash: tokenHash(secret),
        generation,
        bot_id: setup.bot_id,
        revoked: false,
        created_at: this.now(),
        last_seen: null,
        offset: 0,
      });
      tx.set('bot_runtime_apps/' + tokenHash(applicationId), { account_id: accountId });
      if (!shop) tx.set(root(accountId), this.initial(account.store_name));
      this.audit(tx, accountId, 'bot_runtime.provisioned', 'server-bootstrap');
    });
    return `botr_${accountId}_${secret}`;
  }
  async revoke(accountId: string) {
    await buffered(this.store, async (tx) => {
      const r = await tx.get('bot_runtimes/' + accountId);
      if (r) tx.set('bot_runtimes/' + accountId, { ...r, revoked: true });
      this.audit(tx, accountId, 'bot_runtime.revoked', 'server-bootstrap');
    });
  }
  async authenticate(key: string): Promise<RuntimeAccess> {
    const match = /^botr_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(key);
    if (!match)
      throw new HttpError(401, 'RUNTIME_UNAUTHORIZED', 'Credencial de execução inválida.');
    const r = await this.store.get('bot_runtimes/' + match[1]);
    const digest = tokenHash(match[2]);
    if (
      !r ||
      r.revoked ||
      typeof r.secret_hash !== 'string' ||
      r.secret_hash.length !== digest.length ||
      !timingSafeEqual(Buffer.from(digest), Buffer.from(r.secret_hash))
    )
      throw new HttpError(401, 'RUNTIME_UNAUTHORIZED', 'Credencial de execução inválida.');
    return { accountId: match[1], generation: r.generation };
  }
  private async access(tx: DocumentTransaction, auth: RuntimeAccess) {
    const runtime = await tx.get('bot_runtimes/' + auth.accountId),
      { account, setup } = await this.lifecycle(tx, auth.accountId);
    if (
      !runtime ||
      runtime.revoked ||
      runtime.generation !== auth.generation ||
      runtime.bot_id !== setup.bot_id
    )
      throw unavailable();
    const shop = (await tx.get(root(auth.accountId))) as Shop | null;
    if (!shop) throw unavailable();
    return { runtime, account, setup, shop };
  }
  async configuration(auth: RuntimeAccess) {
    return buffered(this.store, async (tx) => {
      const { runtime, account, setup, shop } = await this.access(tx, auth);
      if (!['configuring', 'active'].includes(setup.activation_status)) throw unavailable();
      const secret = await tx.get('merchant_bot_secrets/' + auth.accountId);
      if (!secret) throw unavailable();
      return {
        accountId: auth.accountId,
        applicationId: runtime.application_id,
        botId: setup.bot_id,
        botToken: this.vault.open(secret.ciphertext, auth.accountId + ':' + setup.bot_id),
        username: setup.bot_username,
        offset:
          runtime.last_update_at &&
          this.now().getTime() - runtime.last_update_at.getTime() < 6 * 86400000
            ? runtime.offset
            : 0,
        ownerVerified:
          shop.owner_id === setup.telegram_user_id && shop.owner_bot_id === setup.bot_id,
      };
    });
  }
  async status(accountId: string) {
    const runtime = await this.store.get('bot_runtimes/' + accountId),
      shop = await this.store.get(root(accountId)),
      setup = await this.store.get('merchant_bot_setup/' + accountId);
    return {
      provisioned: Boolean(runtime && !runtime.revoked && runtime.bot_id === setup?.bot_id),
      online: Boolean(
        runtime &&
          !runtime.revoked &&
          runtime.last_seen &&
          this.now().getTime() - runtime.last_seen.getTime() < 90000,
      ),
      ownerVerified: Boolean(
        shop?.owner_id &&
          shop.owner_id === setup?.telegram_user_id &&
          shop.owner_bot_id === setup?.bot_id,
      ),
      lastSeen: runtime?.last_seen ?? null,
    };
  }
  async ownerLink(accountId: string, uid: string) {
    const code = randomBytes(24).toString('base64url');
    return buffered(this.store, async (tx) => {
      const { account, setup } = await this.lifecycle(tx, accountId),
        runtime = await tx.get('bot_runtimes/' + accountId);
      if (
        account.firebase_uid !== uid ||
        account.access_status !== 'approved' ||
        !runtime ||
        runtime.revoked ||
        runtime.bot_id !== setup.bot_id
      )
        throw unavailable();
      tx.set(path(accountId, 'private', 'owner_link'), {
        hash: tokenHash(code),
        expires_at: new Date(this.now().getTime() + 600000),
        telegram_id: setup.telegram_user_id,
        bot_id: setup.bot_id,
      });
      this.audit(tx, accountId, 'bot_owner.link_requested', uid);
      return {
        url: `https://t.me/${setup.bot_username}?start=owner_${code}`,
        expiresInSeconds: 600,
      };
    });
  }
  private audit(tx: DocumentTransaction, id: string, action: string, actor: string) {
    const key = randomUUID();
    tx.set('platform_audit/' + key, {
      id: key,
      account_id: id,
      action,
      actor_uid: actor,
      subject_uid: null,
      created_at: this.now(),
    });
  }

  async process(auth: RuntimeAccess, input: unknown) {
    const update = telegramUpdate.parse(input);
    return buffered(this.store, async (tx) => {
      const { runtime, account, setup, shop } = await this.access(tx, auth),
        id = auth.accountId;
      const receiptPath = path(id, 'updates', String(update.update_id));
      const receipt = await tx.get(receiptPath);
      if (receipt) return { effectIds: receipt.effect_ids as string[], duplicate: true };
      const effects: BotEffect[] = [];
      const effect = (
        method: TelegramMethod,
        payload: Record<string, unknown>,
        order?: Order,
        delivery = false,
      ) => {
        const key = `u${update.update_id}_${effects.length}`;
        effects.push({
          id: key,
          method,
          payload,
          status: 'pending',
          ...(order ? { order_id: order.id } : {}),
          ...(delivery ? { delivery: true } : {}),
        });
        return key;
      };
      const msg = update.message,
        callback = update.callback_query,
        pre = update.pre_checkout_query;
      const from = msg?.from ?? callback?.from ?? pre?.from;
      const chat = msg?.chat ?? callback?.message?.chat;
      const userId = String(from?.id ?? ''),
        chatId = chat?.id ?? from?.id;
      const say = (
        text: string,
        markup?: ReturnType<typeof buttons>,
        target: number | string | undefined = chatId,
      ) => {
        if (target)
          effect('sendMessage', {
            chat_id: target,
            text,
            ...(markup ? { reply_markup: markup } : {}),
          });
      };
      const operational =
        account.access_status === 'approved' &&
        ['configuring', 'active'].includes(setup.activation_status);
      const selling =
        operational &&
        setup.activation_status === 'active' &&
        account.paid_through instanceof Date &&
        account.paid_through > this.now();
      const owner =
        shop.owner_id === userId &&
        shop.owner_id === setup.telegram_user_id &&
        shop.owner_bot_id === setup.bot_id;
      const saveShop = () => tx.set(root(id), shop);
      const productDoc = (pid: string) => path(id, 'products', pid);
      const orderDoc = (oid: string) => path(id, 'orders', oid);
      const cartPath = path(id, 'customers', userId || 'unknown');
      const customer = (await tx.get(cartPath)) ?? {
        items: [],
        coupon: '',
        orders: [],
        session: null,
      };
      const saveCustomer = () => tx.set(cartPath, customer);
      const menu = () =>
        buttons([
          [
            ['🛍 Produtos', 'catalog'],
            ['🛒 Carrinho', 'cart'],
          ],
          [
            ['📦 Meus pedidos', 'orders'],
            ['💬 Suporte', 'support'],
          ],
          ...(owner ? [[['⚙️ Administrar', 'admin']] as [string, string][]] : []),
        ]);
      const adminMenu = () =>
        buttons([
          [
            ['➕ Produto', 'admin:new'],
            ['📦 Estoque', 'admin:stock'],
          ],
          [
            ['📝 Editar produto', 'admin:edit'],
            ['🎟 Cupom', 'admin:coupon'],
          ],
          [
            ['🖼 Banner', 'admin:banner'],
            ['👋 Boas-vindas', 'admin:welcome'],
          ],
          [
            ['💬 Suporte', 'admin:support'],
            ['📋 Pedidos', 'admin:orders'],
          ],
          [['🏪 Abrir loja', 'catalog']],
        ]);
      const release = async (order: Order, status: 'expired' | 'cancelled') => {
        for (const item of order.items) {
          const p = await tx.get(productDoc(item.product_id));
          if (!p) throw Error('Reserved product missing');
          p.units.push(...item.units);
          const meta = shop.products.find((v) => v.id === item.product_id);
          if (meta) meta.stock = p.units.length;
          tx.set(productDoc(item.product_id), p);
        }
        if (order.coupon && shop.coupons[order.coupon]) shop.coupons[order.coupon].used--;
        order.status = status;
        order.items = order.items.map((v) => ({ ...v, units: [] }));
        tx.set(orderDoc(order.id), order);
        shop.open_orders = shop.open_orders.filter((v) => v !== order.id);
      };
      // At most 25 simultaneous reservations per shop; expired stock is reclaimed transactionally.
      for (const oid of [...shop.open_orders]) {
        // Telegram requires a checkout answer within ten seconds. Do not sweep
        // unrelated reservations on a payment's latency-critical path.
        if (pre || (msg?.successful_payment && oid !== msg.successful_payment.invoice_payload))
          continue;
        const order = (await tx.get(orderDoc(oid))) as Order | null;
        if (order && isOpen(order) && order.expires_at <= this.now())
          await release(order, 'expired');
      }

      const pendingDelivery = (order: Order) => {
        const ids: string[] = [];
        say(
          `Pagamento confirmado. Pedido ${order.id}. A entrega segue abaixo.`,
          undefined,
          order.buyer_id,
        );
        for (const item of order.items)
          for (const unit of item.units) {
            const content = JSON.parse(
              this.vault.open(unit.ciphertext, `${id}:stock:${item.product_id}:${unit.id}`),
            );
            ids.push(
              content.kind === 'document'
                ? effect(
                    'sendDocument',
                    { chat_id: order.buyer_id, document: content.fileId, caption: item.title },
                    order,
                    true,
                  )
                : effect(
                    'sendMessage',
                    { chat_id: order.buyer_id, text: `${item.title}\n\n${content.text}` },
                    order,
                    true,
                  ),
            );
          }
        order.delivery_effects = ids;
      };
      const showProduct = (p: Product) =>
        say(
          `${p.title}\n${p.description}\n\nPreço: ${isoMoney(p.price)}\nDisponíveis: ${p.stock}`,
          buttons([[['Adicionar ao carrinho', 'add:' + p.id]], [['Voltar', 'catalog']]]),
        );
      const catalog = (category?: string) => {
        const categories = [
          ...new Set(shop.products.filter((p) => p.enabled).map((p) => p.category)),
        ].sort();
        if (!category && categories.length > 1) {
          say(
            'Escolha uma categoria:',
            buttons(categories.map((name, index) => [[name, 'cat:' + index]])),
          );
          return;
        }
        const available = shop.products
          .filter((p) => p.enabled && (!category || p.category === category))
          .sort((a, b) => a.category.localeCompare(b.category));
        if (!available.length) {
          say('O catálogo ainda não tem produtos disponíveis.', menu());
          return;
        }
        say(
          'Escolha um produto:',
          buttons([
            ...available.map(
              (p) =>
                [[`${p.title} · ${isoMoney(p.price)} · ${p.stock} un.`, 'p:' + p.id]] as [
                  string,
                  string,
                ][],
            ),
            [
              ['🛒 Carrinho', 'cart'],
              ['🏠 Início', 'home'],
            ],
          ]),
        );
      };
      const showCart = () => {
        const lines = customer.items.map((item: any) => {
          const p = shop.products.find((v) => v.id === item.id);
          return p
            ? `${item.quantity} × ${p.title} — ${isoMoney(p.price * item.quantity)}`
            : 'Produto indisponível';
        });
        say(
          lines.length
            ? `Seu carrinho\n${lines.join('\n')}\n${customer.coupon ? 'Cupom: ' + customer.coupon : ''}`
            : 'Seu carrinho está vazio.',
          buttons([
            ...customer.items.map(
              (item: any) =>
                [
                  [
                    `− ${shop.products.find((v) => v.id === item.id)?.title ?? 'Produto'}`,
                    'remove:' + item.id,
                  ],
                ] as [string, string][],
            ),
            [['Pagar com Stars', 'checkout']],
            [
              ['Inserir cupom', 'coupon'],
              ['Esvaziar', 'clear'],
            ],
            [['Produtos', 'catalog']],
          ]),
        );
      };
      const listOrders = async (all = false) => {
        const rows: [string, string][][] = [];
        for (const oid of (all ? shop.recent_orders : customer.orders).slice(0, 12)) {
          const o = (await tx.get(orderDoc(oid))) as Order | null;
          if (o && (all || o.buyer_id === userId))
            rows.push([
              [
                `${o.id} · ${o.status} · ${isoMoney(o.total)}`,
                `${all ? 'admin:order:' : 'order:'}${o.id}`,
              ],
            ]);
        }
        say(
          rows.length ? 'Pedidos recentes:' : 'Nenhum pedido encontrado.',
          buttons([...rows, [['Voltar', all ? 'admin' : 'home']]]),
        );
      };

      if (
        !from ||
        from.is_bot ||
        (chat && (chat.type !== 'private' || String(chat.id) !== userId))
      ) {
        if (callback)
          effect('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Use o bot em uma conversa privada.',
          });
      } else if (pre) {
        const order = (await tx.get(orderDoc(pre.invoice_payload))) as Order | null;
        const ok = Boolean(
          selling &&
            order &&
            isOpen(order) &&
            order.buyer_id === userId &&
            pre.currency === 'XTR' &&
            pre.total_amount === order.total &&
            order.expires_at > this.now(),
        );
        if (ok && order) {
          order.status = 'precheckout';
          order.expires_at = new Date(this.now().getTime() + 120000);
          tx.set(orderDoc(order.id), order);
        }
        effect('answerPreCheckoutQuery', {
          pre_checkout_query_id: pre.id,
          ok,
          ...(!ok
            ? {
                error_message:
                  'Pedido indisponível ou vencido. Volte ao carrinho para gerar outro.',
              }
            : {}),
        });
      } else if (msg?.successful_payment) {
        const payment = msg.successful_payment,
          order = (await tx.get(orderDoc(payment.invoice_payload))) as Order | null;
        const chargePath = path(id, 'charges', tokenHash(payment.telegram_payment_charge_id));
        const charge = await tx.get(chargePath);
        if (!charge) {
          if (
            order &&
            order.buyer_id === userId &&
            payment.currency === 'XTR' &&
            payment.total_amount === order.total &&
            ['awaiting_payment', 'precheckout'].includes(order.status)
          ) {
            order.status = 'paid';
            order.charge_id = payment.telegram_payment_charge_id;
            pendingDelivery(order);
            tx.set(orderDoc(order.id), order);
            shop.open_orders = shop.open_orders.filter((v) => v !== order.id);
            if (shop.owner_id)
              say(
                `Pagamento confirmado para o pedido ${order.id}: ${isoMoney(order.total)}.`,
                undefined,
                shop.owner_id,
              );
          } else {
            if (
              order &&
              order.buyer_id === userId &&
              payment.currency === 'XTR' &&
              payment.total_amount === order.total &&
              !order.charge_id
            ) {
              order.status = 'refund_required';
              order.charge_id = payment.telegram_payment_charge_id;
              tx.set(orderDoc(order.id), order);
            } else if (payment.currency === 'XTR') {
              const reviewId = randomBytes(8).toString('hex');
              tx.set(orderDoc(reviewId), {
                id: reviewId,
                buyer_id: userId,
                items: [],
                total: payment.total_amount,
                coupon: '',
                created_at: this.now(),
                expires_at: this.now(),
                status: 'refund_required',
                charge_id: payment.telegram_payment_charge_id,
                payment_reference: payment.invoice_payload,
              });
              shop.recent_orders = [reviewId, ...shop.recent_orders].slice(0, 50);
            }
            say('Recebemos uma confirmação de pagamento que precisa de revisão. Use /paysupport.');
            if (shop.owner_id)
              say(
                `Pagamento requer revisão: ${payment.invoice_payload}. Nenhuma nova unidade foi retirada. Consulte /admin.`,
                undefined,
                shop.owner_id,
              );
          }
          tx.set(chargePath, {
            order_id: payment.invoice_payload,
            buyer_id: userId,
            charge_id: payment.telegram_payment_charge_id,
            total: payment.total_amount,
            currency: payment.currency,
            created_at: this.now(),
          });
          this.audit(tx, id, 'bot_order.payment_received', userId);
        }
      } else if (msg?.refunded_payment) {
        const refund = msg.refunded_payment,
          order = (await tx.get(orderDoc(refund.invoice_payload))) as Order | null;
        if (order?.charge_id === refund.telegram_payment_charge_id && order.buyer_id === userId) {
          order.status = 'refunded';
          tx.set(orderDoc(order.id), order);
          this.audit(tx, id, 'bot_order.refunded', userId);
        }
      } else {
        if (callback) effect('answerCallbackQuery', { callback_query_id: callback.id });
        const text = msg?.text?.trim() ?? '',
          cmd = callback?.data ?? (text.startsWith('/') ? text.split(/\s/)[0].split('@')[0] : ''),
          argument = text.split(/\s+/).slice(1).join(' ');
        if (cmd === '/start' && /^owner_[A-Za-z0-9_-]{32}$/.test(argument)) {
          const link = await tx.get(path(id, 'private', 'owner_link'));
          if (
            operational &&
            link?.hash === tokenHash(argument.slice(6)) &&
            link.expires_at > this.now() &&
            link.telegram_id === userId &&
            link.bot_id === setup.bot_id
          ) {
            shop.owner_id = userId;
            shop.owner_bot_id = setup.bot_id;
            tx.delete(path(id, 'private', 'owner_link'));
            this.audit(tx, id, 'bot_owner.verified', account.firebase_uid);
            say('Responsável confirmado. Use /admin para configurar sua loja.', adminMenu());
          } else
            say(
              'Este vínculo está vencido ou não corresponde à sua conta. Gere outro link no site.',
            );
        } else if (cmd === '/cancelar' || cmd === 'admin:cancel') {
          customer.session = null;
          saveCustomer();
          say('Operação cancelada.', owner ? adminMenu() : menu());
        } else if (cmd === '/paysupport' || cmd === '/suporte' || cmd === 'support') {
          say(
            shop.support
              ? `Atendimento: ${shop.support}`
              : 'Atendimento ainda não configurado pelo lojista. Guarde o número do seu pedido.',
          );
        } else if (cmd === '/help' || cmd === '/terms') {
          say(
            'Use /start para abrir a loja, /pedidos para acompanhar compras e /paysupport para ajuda com pagamentos. Produtos digitais são pagos em Telegram Stars. O estoque é reservado por 20 minutos e entregue após confirmação do Telegram. Não envie senhas ou dados de cartão ao bot.',
            menu(),
          );
        } else if (!operational && (cmd === 'orders' || cmd === '/pedidos')) {
          await listOrders();
        } else if (!operational && cmd.startsWith('order:')) {
          const order = (await tx.get(orderDoc(cmd.slice(6)))) as Order | null;
          if (order?.buyer_id === userId)
            say(`Pedido ${order.id}\nEstado: ${order.status}\nTotal: ${isoMoney(order.total)}`);
          else say('Pedido não encontrado.');
        } else if (!operational) {
          say(
            'Esta loja está temporariamente indisponível. Seu histórico de compras permanece salvo.',
          );
        } else if ((cmd === '/admin' || cmd === 'admin' || cmd.startsWith('admin:')) && !owner) {
          say('A administração está disponível somente ao responsável confirmado pelo site.');
        } else if (owner && (cmd === '/admin' || cmd === 'admin')) {
          customer.session = null;
          saveCustomer();
          say('Administração da loja', adminMenu());
        } else if (owner && cmd.startsWith('admin:')) {
          const action = cmd.slice(6);
          if (action === 'new') {
            customer.session = { step: 'product_title' };
            say('Qual é o nome do produto? Envie /cancelar para sair.');
          } else if (['stock', 'edit'].includes(action))
            say(
              'Escolha o produto:',
              buttons(
                shop.products.map((p) => [
                  [p.title, `admin:${action === 'stock' ? 'stockfor' : 'editfor'}:${p.id}`],
                ]),
              ),
            );
          else if (action.startsWith('stockfor:')) {
            customer.session = { step: 'stock', product: action.slice(9) };
            say(
              'Envie uma unidade por linha (até 20), ou envie um arquivo para adicionar uma unidade de arquivo. O conteúdo fica cifrado.',
            );
          } else if (action.startsWith('editfor:')) {
            const pid = action.slice(8);
            say(
              'Escolha o que alterar:',
              buttons([
                [
                  ['Nome', `admin:field:title:${pid}`],
                  ['Preço', `admin:field:price:${pid}`],
                ],
                [
                  ['Descrição', `admin:field:description:${pid}`],
                  ['Categoria', `admin:field:category:${pid}`],
                ],
                [['Ativar/desativar', `admin:toggle:${pid}`]],
              ]),
            );
          } else if (action.startsWith('field:')) {
            const [, field, pid] = action.split(':');
            customer.session = { step: 'edit', field, product: pid };
            say(field === 'price' ? 'Envie o novo preço inteiro em Stars.' : 'Envie o novo valor.');
          } else if (action.startsWith('toggle:')) {
            const p = shop.products.find((v) => v.id === action.slice(7));
            if (p) p.enabled = !p.enabled;
            say('Disponibilidade atualizada.', adminMenu());
          } else if (['banner', 'welcome', 'support', 'coupon'].includes(action)) {
            customer.session = { step: action === 'coupon' ? 'admin_coupon' : action };
            say(
              action === 'banner'
                ? 'Envie a foto do banner, ou “remover”.'
                : action === 'welcome'
                  ? 'Envie a mensagem de boas-vindas (até 600 caracteres).'
                  : action === 'support'
                    ? 'Envie seu @usuario de atendimento no Telegram.'
                    : 'Envie CÓDIGO DESCONTO LIMITE. Exemplo: BEMVINDO 10 50 (10% para até 50 pedidos).',
            );
          } else if (action === 'orders') await listOrders(true);
          else if (action.startsWith('order:')) {
            const o = (await tx.get(orderDoc(action.slice(6)))) as Order | null;
            if (o)
              say(
                `Pedido ${o.id}\nEstado: ${o.status}\nCliente: ${o.buyer_id}\nTotal: ${isoMoney(o.total)}\n${o.items.map((v) => `${v.quantity} × ${v.title}`).join('\n')}`,
                buttons([
                  [['Reentregar (confirmar)', `admin:redeliver:${o.id}`]],
                  [['Reembolsar Stars (confirmar)', `admin:refund:${o.id}`]],
                  [['Voltar', 'admin:orders']],
                ]),
              );
          } else if (action.startsWith('refund:')) {
            const o = (await tx.get(orderDoc(action.slice(7)))) as Order | null;
            if (o?.charge_id && ['paid', 'delivered', 'refund_required'].includes(o.status))
              say(
                `Devolver ${isoMoney(o.total)} ao comprador do pedido ${o.id}? Conteúdos já enviados não podem ser recuperados.`,
                buttons([
                  [['Confirmar reembolso', `admin:dorefund:${o.id}`]],
                  [['Cancelar', 'admin:orders']],
                ]),
              );
          } else if (action.startsWith('dorefund:')) {
            const o = (await tx.get(orderDoc(action.slice(9)))) as Order | null;
            if (o?.charge_id && ['paid', 'delivered', 'refund_required'].includes(o.status)) {
              effect(
                'refundStarPayment',
                { user_id: Number(o.buyer_id), telegram_payment_charge_id: o.charge_id },
                o,
              );
              o.status = 'refund_pending';
              tx.set(orderDoc(o.id), o);
              this.audit(tx, id, 'bot_order.refund_requested', userId);
              say(
                'Reembolso solicitado. Confira o estado do pedido após a confirmação do Telegram.',
                adminMenu(),
              );
            }
          } else if (action.startsWith('redeliver:')) {
            const o = (await tx.get(orderDoc(action.slice(10)))) as Order | null;
            if (o && ['paid', 'delivered'].includes(o.status)) {
              say(
                'Reenviar o mesmo conteúdo já vendido ao comprador? Isso não retira outra unidade do estoque.',
                buttons([
                  [['Confirmar reentrega', `admin:resend:${o.id}`]],
                  [['Cancelar', 'admin:orders']],
                ]),
              );
            }
          } else if (action.startsWith('resend:')) {
            const o = (await tx.get(orderDoc(action.slice(7)))) as Order | null;
            if (o && ['paid', 'delivered'].includes(o.status)) {
              o.status = 'paid';
              pendingDelivery(o);
              tx.set(orderDoc(o.id), o);
              this.audit(tx, id, 'bot_order.redelivery_requested', userId);
              say('Reentrega do conteúdo original agendada.', adminMenu());
            }
          }
          saveCustomer();
        } else if (customer.session && msg && !cmd) {
          const session = customer.session;
          if (session.step === 'coupon') {
            const code = text.toUpperCase();
            if (shop.coupons[code]) {
              customer.coupon = code;
              customer.session = null;
              say('Cupom aplicado.');
              showCart();
            } else say('Cupom não encontrado.');
          } else if (!owner) {
            customer.session = null;
            say('Operação indisponível.');
          } else if (session.step === 'product_title') {
            if (text.length < 1 || text.length > 70) say('Use de 1 a 70 caracteres.');
            else {
              customer.session = { step: 'product_description', title: text };
              say('Envie a descrição (até 400 caracteres).');
            }
          } else if (session.step === 'product_description') {
            if (text.length > 400 || !text) say('Use de 1 a 400 caracteres.');
            else {
              customer.session = { ...session, step: 'product_price', description: text };
              say('Qual é o preço inteiro em Telegram Stars?');
            }
          } else if (session.step === 'product_price') {
            const price = Number(text);
            if (!Number.isSafeInteger(price) || price < 1 || price > 1000000)
              say('Envie um número inteiro de 1 a 1000000.');
            else {
              customer.session = { ...session, step: 'product_category', price };
              say('Qual é a categoria do produto (até 40 caracteres)?');
            }
          } else if (session.step === 'product_category') {
            if (!text || text.length > 40) say('Use de 1 a 40 caracteres.');
            else if (shop.products.length >= 40) {
              customer.session = null;
              say('Limite de 40 produtos por loja atingido.');
            } else {
              const pid = randomBytes(6).toString('hex');
              shop.products.push({
                id: pid,
                title: session.title,
                description: session.description,
                price: session.price,
                category: text,
                stock: 0,
                enabled: true,
              });
              tx.set(productDoc(pid), { id: pid, units: [] });
              customer.session = null;
              say('Produto criado. Use Estoque para adicionar as unidades.', adminMenu());
            }
          } else if (session.step === 'stock') {
            const p = shop.products.find((v) => v.id === session.product),
              stock = await tx.get(productDoc(session.product));
            const units = msg.document
              ? [{ kind: 'document', fileId: msg.document.file_id }]
              : text
                  .split('\n')
                  .map((v) => v.trim())
                  .filter(Boolean)
                  .map((v) => ({ kind: 'text', text: v }));
            if (!p || !stock) {
              customer.session = null;
              say('Produto não encontrado.');
            } else if (
              !units.length ||
              units.length > 20 ||
              units.some((v) => JSON.stringify(v).length > 1200) ||
              stock.units.length + units.length > 100
            )
              say(
                'Envie até 20 unidades de até 1000 caracteres. Limite: 100 unidades disponíveis por produto.',
              );
            else {
              for (const unit of units) {
                const unitId = randomBytes(8).toString('hex');
                stock.units.push({
                  id: unitId,
                  ciphertext: this.vault.seal(
                    JSON.stringify(unit),
                    `${id}:stock:${p.id}:${unitId}`,
                  ),
                });
              }
              p.stock = stock.units.length;
              tx.set(productDoc(p.id), stock);
              customer.session = null;
              say(`${units.length} unidade(s) adicionada(s).`, adminMenu());
            }
          } else if (session.step === 'welcome') {
            if (!text || text.length > 600) say('Use de 1 a 600 caracteres.');
            else {
              shop.welcome = text;
              customer.session = null;
              say('Mensagem atualizada.', adminMenu());
            }
          } else if (session.step === 'support') {
            if (!/^@[A-Za-z0-9_]{5,32}$/.test(text)) say('Envie um @usuario válido.');
            else {
              shop.support = text;
              customer.session = null;
              say('Atendimento atualizado.', adminMenu());
            }
          } else if (session.step === 'banner') {
            const photo = msg.photo?.at(-1);
            if (photo || text === 'remover') {
              shop.banner = photo?.file_id ?? '';
              customer.session = null;
              say('Banner atualizado.', adminMenu());
            } else say('Envie uma foto ou a palavra remover.');
          } else if (session.step === 'admin_coupon') {
            const match = /^([A-Z0-9_-]{3,20})\s+(\d{1,2})\s+(\d{1,5})$/.exec(text.toUpperCase());
            if (!match || Number(match[2]) < 1 || Number(match[2]) > 90 || Number(match[3]) < 1)
              say('Use CÓDIGO DESCONTO LIMITE, com desconto de 1 a 90%.');
            else if (shop.coupons[match[1]])
              say('Este código já existe. Use outro para preservar os pedidos anteriores.');
            else if (Object.keys(shop.coupons).length >= 20)
              say('Limite de 20 cupons por loja atingido.');
            else {
              shop.coupons[match[1]] = {
                percent: Number(match[2]),
                limit: Number(match[3]),
                used: 0,
              };
              customer.session = null;
              say('Cupom criado.', adminMenu());
            }
          } else if (session.step === 'edit') {
            const p = shop.products.find((v) => v.id === session.product),
              field = session.field;
            if (!p || !['title', 'description', 'category', 'price'].includes(field)) {
              customer.session = null;
              say('Produto não encontrado.');
            } else if (field === 'price') {
              const price = Number(text);
              if (!Number.isInteger(price) || price < 1 || price > 1000000) say('Preço inválido.');
              else {
                p.price = price;
                customer.session = null;
                say('Preço atualizado.', adminMenu());
              }
            } else if (
              !text ||
              text.length >
                ({ title: 70, description: 400, category: 40 } as Record<string, number>)[field]
            )
              say('Valor inválido ou muito longo.');
            else {
              (p as unknown as Record<string, unknown>)[field] = text;
              customer.session = null;
              say('Produto atualizado.', adminMenu());
            }
          }
          saveCustomer();
        } else if (cmd.startsWith('cat:')) {
          const categories = [
              ...new Set(shop.products.filter((p) => p.enabled).map((p) => p.category)),
            ].sort(),
            category = categories[Number(cmd.slice(4))];
          if (!selling && !owner) say('A loja ainda não está recebendo pedidos.');
          else if (category) catalog(category);
        } else if (cmd.startsWith('remove:')) {
          const item = customer.items.find((v: any) => v.id === cmd.slice(7));
          if (item) {
            item.quantity--;
            customer.items = customer.items.filter((v: any) => v.quantity > 0);
            saveCustomer();
          }
          showCart();
        } else if (cmd === 'catalog' || cmd === '/produtos') {
          if (!selling && !owner) say('A loja ainda não está recebendo pedidos.');
          else catalog();
        } else if (cmd.startsWith('p:')) {
          const p = shop.products.find((v) => v.id === cmd.slice(2) && v.enabled);
          if (p) showProduct(p);
          else say('Produto indisponível.');
        } else if (cmd.startsWith('add:')) {
          const p = shop.products.find((v) => v.id === cmd.slice(4) && v.enabled);
          if (!selling) say('A loja não está recebendo novos pedidos.');
          else if (!p?.stock) say('Produto sem estoque.');
          else {
            const current = customer.items.find((v: any) => v.id === p.id);
            if (customer.items.reduce((s: number, v: any) => s + v.quantity, 0) >= 10)
              say('Limite de 10 unidades por pedido.');
            else {
              if (current) current.quantity++;
              else customer.items.push({ id: p.id, quantity: 1 });
              saveCustomer();
              say('Adicionado ao carrinho.', menu());
            }
          }
        } else if (cmd === 'cart' || cmd === '/carrinho') showCart();
        else if (cmd === 'clear') {
          customer.items = [];
          customer.coupon = '';
          saveCustomer();
          showCart();
        } else if (cmd === 'coupon') {
          customer.session = { step: 'coupon' };
          saveCustomer();
          say('Envie o código do cupom.');
        } else if (cmd === 'checkout') {
          if (!selling) say('A loja não está recebendo novos pedidos.');
          else if (!shop.support)
            say('O lojista precisa configurar o atendimento antes de receber pagamentos.');
          else if (!customer.items.length) say('Adicione um produto ao carrinho.');
          else if (shop.open_orders.length >= 25)
            say('Há muitos pedidos em andamento. Aguarde alguns minutos.');
          else {
            const coupon = customer.coupon ? shop.coupons[customer.coupon] : null;
            const reservation: Order['items'] = [];
            let total = 0,
              valid = !customer.coupon || Boolean(coupon && coupon.used < coupon.limit);
            for (const item of customer.items) {
              const p = shop.products.find((v) => v.id === item.id && v.enabled),
                stock = await tx.get(productDoc(item.id));
              if (!p || !stock || stock.units.length < item.quantity) {
                valid = false;
                break;
              }
              reservation.push({
                product_id: p.id,
                title: p.title,
                quantity: item.quantity,
                units: stock.units.slice(0, item.quantity),
              });
              total += p.price * item.quantity;
            }
            if (!valid) say('Estoque ou cupom indisponível. Atualize seu carrinho.');
            else {
              total = Math.max(1, Math.floor((total * (100 - (coupon?.percent ?? 0))) / 100));
              const oid = randomBytes(8).toString('hex'),
                now = this.now();
              const order: Order = {
                id: oid,
                buyer_id: userId,
                items: reservation,
                total,
                coupon: customer.coupon,
                created_at: now,
                expires_at: new Date(now.getTime() + 1200000),
                status: 'awaiting_payment',
              };
              for (const item of reservation) {
                const stock = (await tx.get(productDoc(item.product_id)))!;
                stock.units.splice(0, item.quantity);
                shop.products.find((v) => v.id === item.product_id)!.stock = stock.units.length;
                tx.set(productDoc(item.product_id), stock);
              }
              if (coupon) coupon.used++;
              tx.set(orderDoc(oid), order);
              shop.recent_orders = [oid, ...shop.recent_orders].slice(0, 50);
              shop.open_orders.push(oid);
              customer.orders = [oid, ...customer.orders].slice(0, 30);
              customer.items = [];
              customer.coupon = '';
              saveCustomer();
              effect(
                'sendInvoice',
                {
                  chat_id: chatId,
                  title: shop.title.slice(0, 32),
                  description:
                    `Pedido ${oid} · ${reservation.map((v) => `${v.quantity} × ${v.title}`).join(', ')}`.slice(
                      0,
                      255,
                    ),
                  payload: oid,
                  provider_token: '',
                  currency: 'XTR',
                  prices: [{ label: 'Pedido ' + oid, amount: total }],
                  start_parameter: 'order_' + oid,
                },
                order,
              );
              say(
                `Pedido ${oid}. Estoque reservado por 20 minutos.`,
                buttons([[['Cancelar pedido', 'cancel:' + oid]]]),
              );
              this.audit(tx, id, 'bot_order.created', userId);
            }
          }
        } else if (cmd === 'orders' || cmd === '/pedidos') await listOrders();
        else if (cmd.startsWith('order:')) {
          const o = (await tx.get(orderDoc(cmd.slice(6)))) as Order | null;
          if (o && o.buyer_id === userId)
            say(`Pedido ${o.id}\nEstado: ${o.status}\nTotal: ${isoMoney(o.total)}`, menu());
          else say('Pedido não encontrado.');
        } else if (cmd.startsWith('cancel:')) {
          const o = (await tx.get(orderDoc(cmd.slice(7)))) as Order | null;
          if (o && o.buyer_id === userId && o.status === 'awaiting_payment') {
            await release(o, 'cancelled');
            say('Pedido cancelado e estoque liberado.', menu());
          } else say('Este pedido não pode ser cancelado aqui. Use /paysupport.');
        } else {
          if (shop.banner) effect('sendPhoto', { chat_id: chatId, photo: shop.banner });
          say(
            `${shop.title}\n\n${shop.welcome}${!selling ? '\n\nLoja em configuração ou temporariamente sem novas vendas.' : ''}`,
            menu(),
          );
        }
      }
      saveShop();
      const effectIds = effects.map((v) => v.id);
      for (const out of effects) {
        const { payload, ...meta } = out;
        tx.set(path(id, 'effects', out.id), {
          ...meta,
          payload_ciphertext: this.vault.seal(JSON.stringify(payload), `${id}:effect:${out.id}`),
          created_at: this.now(),
        });
      }
      tx.set(receiptPath, {
        id: String(update.update_id),
        effect_ids: effectIds,
        created_at: this.now(),
      });
      tx.set('bot_runtimes/' + id, {
        ...runtime,
        offset: update.update_id + 1,
        last_update_at: this.now(),
        last_seen: this.now(),
      });
      return { effectIds, duplicate: false };
    });
  }

  async tick(auth: RuntimeAccess) {
    return buffered(this.store, async (tx) => {
      const { runtime, account, setup, shop } = await this.access(tx, auth);
      if (
        setup.activation_status === 'active' &&
        shop.owner_id &&
        account.paid_through instanceof Date
      ) {
        const days = Math.ceil((account.paid_through.getTime() - this.now().getTime()) / 86400000),
          day = Math.max(0, days);
        if ([10, 5, 3, 1, 0].includes(day)) {
          const eid = 'r' + tokenHash(account.paid_through.toISOString() + ':' + day).slice(0, 24),
            target = path(auth.accountId, 'effects', eid);
          if (!(await tx.get(target))) {
            const payload = {
              chat_id: shop.owner_id,
              text:
                day === 0
                  ? 'Seu período Blackout Create venceu. Novos pedidos estão pausados. Seu histórico e suporte permanecem disponíveis. Entre no site e fale pelo canal da contratação para renovar.'
                  : `Sua assinatura Blackout Create vence em ${day} dia(s). Consulte a contratação no site para renovar.`,
            };
            tx.set(target, {
              id: eid,
              method: 'sendMessage',
              status: 'pending',
              created_at: this.now(),
              payload_ciphertext: this.vault.seal(
                JSON.stringify(payload),
                `${auth.accountId}:effect:${eid}`,
              ),
            });
          }
        }
      }
      tx.set('bot_runtimes/' + auth.accountId, { ...runtime, last_seen: this.now() });
      return { offset: runtime.offset };
    });
  }
  async renew(accountId: string, actor: string, requestId: string) {
    return buffered(this.store, async (tx) => {
      const { account, setup } = await this.lifecycle(tx, accountId),
        receiptPath = path(accountId, 'renewals', requestId),
        receipt = await tx.get(receiptPath);
      if (receipt) return { paidThrough: receipt.paid_through };
      if (setup.activation_status !== 'active' || !account.billing_started_at)
        throw new HttpError(409, 'BOT_NOT_ACTIVATED', 'Ative e teste o bot antes da renovação.');
      const base = account.paid_through > this.now() ? account.paid_through : this.now(),
        until = nextBillingMonth(base);
      tx.set('merchant_accounts/' + accountId, { ...account, paid_through: until });
      tx.set(receiptPath, { id: requestId, created_at: this.now(), paid_through: until, actor });
      this.audit(tx, accountId, 'bot_subscription.renewed_manually', actor);
      return { paidThrough: until };
    });
  }
  async pending(auth: RuntimeAccess) {
    const values = await this.store.list(root(auth.accountId) + '/effects', {
      limit: 50,
      equals: ['status', 'pending'],
    });
    return values.map((v) => v.id as string);
  }
  async claim(auth: RuntimeAccess, effectId: string) {
    return buffered(this.store, async (tx) => {
      const { account, setup } = await this.access(tx, auth),
        target = path(auth.accountId, 'effects', effectId),
        out = (await tx.get(target)) as (BotEffect & { lease_at?: Date }) | null;
      if (!out || out.status === 'sent' || out.status === 'uncertain') return null;
      if (out.status === 'sending') {
        if (out.lease_at && this.now().getTime() - out.lease_at.getTime() > 120000)
          tx.set(target, { ...out, status: 'uncertain' });
        return null;
      }
      if (out.order_id && (out.delivery || out.method === 'sendInvoice')) {
        const order = (await tx.get(path(auth.accountId, 'orders', out.order_id))) as Order | null;
        if (out.delivery && (!order || !['paid', 'delivered'].includes(order.status))) return null;
        if (
          out.method === 'sendInvoice' &&
          (!order ||
            !isOpen(order) ||
            order.expires_at <= this.now() ||
            account.access_status !== 'approved' ||
            setup.activation_status !== 'active' ||
            account.paid_through <= this.now())
        ) {
          tx.set(target, { ...out, status: 'uncertain', finished_at: this.now() });
          return null;
        }
      }
      const lease = randomBytes(24).toString('base64url');
      tx.set(target, { ...out, status: 'sending', lease, lease_at: this.now() });
      const raw = out as unknown as Doc;
      return {
        id: out.id,
        method: out.method,
        payload: JSON.parse(
          this.vault.open(raw.payload_ciphertext, `${auth.accountId}:effect:${out.id}`),
        ),
        status: 'sending' as const,
        lease,
        ...(out.order_id ? { order_id: out.order_id } : {}),
        ...(out.delivery ? { delivery: true } : {}),
      };
    });
  }
  async acknowledge(
    auth: RuntimeAccess,
    effectId: string,
    lease: string,
    result: 'sent' | 'uncertain',
  ) {
    return buffered(this.store, async (tx) => {
      await this.access(tx, auth);
      const target = path(auth.accountId, 'effects', effectId),
        out = (await tx.get(target)) as BotEffect | null;
      if (!out || out.status !== 'sending' || out.lease !== lease)
        throw new HttpError(409, 'EFFECT_LEASE_INVALID', 'Confirmação de envio inválida.');
      tx.set(target, { ...out, status: result, finished_at: this.now() });
      if (out.method === 'refundStarPayment' && out.order_id && result === 'sent') {
        const order = (await tx.get(path(auth.accountId, 'orders', out.order_id))) as Order | null;
        if (order?.status === 'refund_pending') {
          order.status = 'refunded';
          tx.set(path(auth.accountId, 'orders', order.id), order);
          this.audit(tx, auth.accountId, 'bot_order.refund_confirmed', 'telegram');
        }
      }
      if (out.delivery && out.order_id) {
        const order = (await tx.get(path(auth.accountId, 'orders', out.order_id))) as Order | null;
        if (order?.status === 'paid') {
          let complete = true;
          for (const eid of order.delivery_effects ?? []) {
            const e = await tx.get(path(auth.accountId, 'effects', eid));
            if (e?.status !== 'sent') complete = false;
          }
          if (complete) {
            order.status = 'delivered';
            tx.set(path(auth.accountId, 'orders', order.id), order);
          }
        }
      }
    });
  }
}
