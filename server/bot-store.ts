import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { reuseNavigationMessage } from './bot-navigation.js';
import { categoryEmoji } from './category-emoji.js';
import { queueStockAlerts } from './stock-alerts.js';
import type { PurinWallet } from './purin-wallet.js';
import { tokenHash } from './accounts.js';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { nextBillingMonth } from './billing-period.js';
import {
  botRoot as root,
  botPath as path,
  botButtons as buttons,
  botTransaction as buffered,
} from './bot-data.js';
import { BotAnnouncements } from './bot-announcements.js';
import {
  productText,
  supportDetails,
  supportUrl,
  hasSupport,
  money,
  parsePrice,
} from './bot-appearance.js';
import { BotReceipts } from './bot-receipts.js';
import { manualPixText } from './pix.js';
import { stats, orderSummary, orderLabels, recordPaid, buyerSummary } from './bot-orders.js';
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

const unavailable = () =>
  new HttpError(403, 'BOT_RUNTIME_UNAVAILABLE', 'A operação deste bot está indisponível.');
const isoMoney = money;
const isOpen = (order: Order) =>
  ['awaiting_payment', 'precheckout', 'awaiting_review'].includes(order.status);

export class BotStore {
  wallet?: PurinWallet;
  checkoutOrigin?: string;
  private vault: SecretVault;
  private notices: BotAnnouncements;
  private receipts: BotReceipts;
  constructor(
    readonly store: DocumentStore,
    key: string,
    readonly now: () => Date = () => new Date(),
  ) {
    this.vault = new SecretVault(key);
    this.receipts = new BotReceipts(this.vault);
    this.notices = new BotAnnouncements(store, this.vault, now, (tx, auth) =>
      this.access(tx, auth),
    );
  }

  private async lifecycle(tx: DocumentTransaction, id: string) {
    const [account, setup] = await Promise.all([
      tx.get('merchant_accounts/' + id),
      tx.get('merchant_bot_setup/' + id),
    ]);
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
      payment_mode: 'manual',
      payment_instructions: '',
      review_orders: [],
      stats: {
        orders: 0,
        paid_orders: 0,
        delivered_orders: 0,
        rejected_orders: 0,
        buyers: 0,
        gross_brl: 0,
        gross_stars: 0,
      },
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
    const [runtime, { account, setup }, shop] = await Promise.all([
      tx.get('bot_runtimes/' + auth.accountId),
      this.lifecycle(tx, auth.accountId),
      tx.get(root(auth.accountId)) as Promise<Shop | null>,
    ]);
    if (
      !runtime ||
      runtime.revoked ||
      runtime.generation !== auth.generation ||
      runtime.bot_id !== setup.bot_id
    )
      throw unavailable();
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

  async portalCommand(
    accountId: string,
    uid: string,
    command: string,
    requestId: string,
    reason?: string,
  ) {
    if (
      !/^admin:(?:review-(?:approve|reject):[a-f0-9]{16}:\d{1,6}|notice-(?:send|cancel):[a-f0-9]{12})$/.test(
        command,
      )
    )
      throw new HttpError(400, 'COMMAND_INVALID', 'Ação indisponível.');
    const runtime = await this.store.get('bot_runtimes/' + accountId),
      shop = await this.store.get(root(accountId));
    if (!runtime || !shop?.owner_id) throw unavailable();
    return this.process(
      { accountId, generation: runtime.generation },
      {
        update_id: 0,
        callback_query: {
          id: 'web',
          from: { id: Number(shop.owner_id) },
          data: command,
          message: { chat: { id: Number(shop.owner_id), type: 'private' } },
        },
      },
      { uid, requestId, reason },
    );
  }
  async process(
    auth: RuntimeAccess,
    input: unknown,
    web?: { uid: string; requestId: string; reason?: string },
  ) {
    const update = telegramUpdate.parse(input);
    const walletScreen = !web ? await this.wallet?.telegram(auth, update) : null;
    return buffered(this.store, async (tx) => {
      const { runtime, account, setup, shop } = await this.access(tx, auth),
        id = auth.accountId;
      if (web && account.firebase_uid !== web.uid) throw unavailable();
      const eventKey = web ? 'w' + tokenHash(web.requestId).slice(0, 32) : 'u' + update.update_id;
      const receiptPath = path(
        id,
        web ? 'web_updates' : 'updates',
        web ? tokenHash(web.requestId) : String(update.update_id),
      );
      const receipt = await tx.get(receiptPath);
      if (receipt) return { effectIds: receipt.effect_ids as string[], duplicate: true };
      const effects: BotEffect[] = [];
      const effect = (
        method: TelegramMethod,
        payload: Record<string, unknown>,
        order?: Order,
        delivery = false,
      ) => {
        const key = `${eventKey}_${effects.length}`;
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
        markup?: {
          inline_keyboard: (
            | { text: string; callback_data: string }
            | { text: string; url: string }
          )[][];
        },
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
      const saveShop = () =>
        tx.set(root(id), { ...shop, portal_revision: (shop.portal_revision ?? 0) + 1 });
      const productDoc = (pid: string) => path(id, 'products', pid);
      const orderDoc = (oid: string) => path(id, 'orders', oid);
      const cartPath = path(id, web ? 'web_customers' : 'customers', userId || 'unknown');
      const customer = (await tx.get(cartPath)) ?? {
        items: [],
        coupon: '',
        orders: [],
        session: null,
      };
      const saveCustomer = () => tx.set(cartPath, customer);
      const menu = () => ({
        inline_keyboard: [
          ...buttons([
            [
              ['🛍️ Produtos', 'catalog'],
              ['🛒 Carrinho', 'cart'],
            ],
            [
              ['🧾 Meus pedidos', 'orders'],
              ['💬 Suporte', 'support'],
            ],
            ...(owner ? [[['⚙️ Gerenciar loja', 'admin']] as [string, string][]] : []),
            ...(owner ? [[['Carteira', 'admin:wallet']] as [string, string][]] : []),
          ]).inline_keyboard,
          [{ text: '🚀 Quero um bot igual · Blackout', url: 'https://blackout-create.web.app/' }],
        ],
      });
      const adminMenu = () =>
        buttons([
          [
            ['➕ Novo produto', 'admin:new'],
            ['📦 Estoque', 'admin:stock'],
          ],
          [
            ['✏️ Editar produto', 'admin:edit'],
            ['🎟️ Cupons', 'admin:coupon'],
          ],
          [
            ['🖼️ Banner da loja', 'admin:banner'],
            ['👋 Boas-vindas', 'admin:welcome'],
          ],
          [
            ['💬 Suporte', 'admin:support'],
            ['📋 Pedidos', 'admin:orders'],
          ],
          [
            ['🧾 Pagamentos pendentes', 'admin:pending'],
            ['📊 Estatísticas', 'admin:stats'],
          ],
          [
            ['💳 Pagamentos', 'admin:payment'],
            ['👥 Compradores', 'admin:buyers:'],
          ],
          [
            ['📣 Avisos', 'admin:notices'],
            ['🏪 Abrir loja', 'catalog'],
          ],
          [['Categorias e emojis', 'admin:categories']],
          [['Carteira', 'admin:wallet']],
        ]);
      const release = async (order: Order, status: 'expired' | 'cancelled' | 'rejected') => {
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
        shop.review_orders = (shop.review_orders ?? []).filter((v) => v !== order.id);
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
      const showProduct = (p: Product) => {
        const reply_markup = buttons([
          ...(p.stock > 0
            ? [
                [
                  ['Comprar agora', 'buy:' + p.id],
                  ['Adicionar ao carrinho', 'add:' + p.id],
                ] as [string, string][],
              ]
            : [[['Notificar quando tiver estoque', 'watch:' + p.id]] as [string, string][]]),
          [['↩️ Voltar à categoria', 'cat:' + tokenHash(p.category).slice(0, 16)]],
        ]);
        effect(p.banner ? 'sendPhoto' : 'sendMessage', {
          chat_id: chatId,
          ...(p.banner
            ? { photo: p.banner, caption: productText(p, shop) }
            : { text: productText(p, shop) }),
          reply_markup,
        });
      };
      const catalog = (category?: string) => {
        const categories = [
          ...new Set(shop.products.filter((p) => p.enabled).map((p) => p.category)),
        ].sort();
        if (!category && categories.length) {
          say(
            `${shop.title}\n\nEscolha uma categoria para ver os produtos.`,
            buttons([
              ...categories.map(
                (name) =>
                  [
                    [
                      `${shop.category_emojis?.[name] ? shop.category_emojis[name] + ' ' : ''}${name}`,
                      'cat:' + tokenHash(name).slice(0, 16),
                    ],
                  ] as [string, string][],
              ),
              [
                ['🛒 Carrinho', 'cart'],
                ['🏠 Início', 'home'],
              ],
            ]),
          );
          return;
        }
        const available = shop.products.filter(
          (p) => p.enabled && (!category || p.category === category),
        );
        if (!available.length) {
          say('O catálogo ainda não tem produtos disponíveis.', menu());
          return;
        }
        say(
          `${category}\n\nEscolha um produto para ver os detalhes.`,
          buttons([
            ...available.map(
              (p) =>
                [
                  [
                    `${p.title} · ${isoMoney(p.price, shop.payment_mode === 'manual' ? 'BRL' : 'XTR')} · ${p.stock} un.`,
                    'p:' + p.id,
                  ],
                ] as [string, string][],
            ),
            [
              ['↩️ Categorias', 'catalog'],
              ['🛒 Carrinho', 'cart'],
            ],
          ]),
        );
      };
      const showCart = () => {
        const lines = customer.items.map((item: any) => {
          const p = shop.products.find((v) => v.id === item.id);
          return p
            ? `${item.quantity} × ${p.title} — ${isoMoney(p.price * item.quantity, shop.payment_mode === 'manual' ? 'BRL' : 'XTR')}`
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
            [
              [
                shop.payment_mode === 'manual'
                  ? '💠 Pagar com Pix/transferência'
                  : '⭐ Pagar com Stars',
                'checkout',
              ],
            ],
            [
              ['🎟️ Usar cupom', 'coupon'],
              ['🗑️ Esvaziar carrinho', 'clear'],
            ],
            [['↩️ Categorias', 'catalog']],
          ]),
        );
      };
      const listOrders = async (all = false, cursor?: string, pendingOnly = false) => {
        if (cursor !== undefined && !/^[a-f0-9]{0,16}$/.test(cursor)) {
          say('Página inválida. Abra Meus pedidos novamente.');
          return;
        }
        const rows: [string, string][][] = [];
        const page =
          cursor !== undefined
            ? await this.store.list(root(id) + '/orders', {
                limit: 13,
                afterId: cursor,
                ...(!all ? { equals: ['buyer_id', userId] as [string, unknown] } : {}),
              })
            : null;
        const ids = page
          ? page.slice(0, 12).map((v) => v.id as string)
          : (pendingOnly
              ? (shop.review_orders ?? [])
              : all
                ? shop.recent_orders
                : customer.orders
            ).slice(0, 12);
        for (const oid of ids) {
          const o = (await tx.get(orderDoc(oid))) as Order | null;
          if (o && (all || o.buyer_id === userId))
            rows.push([
              [
                `${o.items[0]?.title ?? 'Pedido'} · ${orderLabels[o.status]} · ${isoMoney(o.total, o.currency)}`,
                `${all ? 'admin:order:' : 'order:'}${o.id}`,
              ],
            ]);
        }
        say(
          rows.length ? 'Pedidos recentes:' : 'Nenhum pedido encontrado.',
          buttons([
            ...rows,
            ...(page && page.length > 12
              ? [
                  [['Mais pedidos', `${all ? 'admin:history' : 'history'}:${page[11].id}`]] as [
                    string,
                    string,
                  ][],
                ]
              : []),
            ...(cursor === undefined && !pendingOnly
              ? [
                  [['Histórico completo', all ? 'admin:history:' : 'history:']] as [
                    string,
                    string,
                  ][],
                ]
              : []),
            [['Voltar', all ? 'admin' : 'home']],
          ]),
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
            order.payment_method !== 'manual' &&
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
            order.currency !== 'BRL' &&
            order.payment_method !== 'manual' &&
            payment.total_amount === order.total &&
            ['awaiting_payment', 'precheckout'].includes(order.status)
          ) {
            order.status = 'paid';
            order.charge_id = payment.telegram_payment_charge_id;
            await recordPaid(tx, id, shop, order, this.now());
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
              order.currency !== 'BRL' &&
              order.payment_method !== 'manual' &&
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
        if (callback && !web) effect('answerCallbackQuery', { callback_query_id: callback.id });
        const text = msg?.text?.trim() ?? '',
          cmd = callback?.data ?? (text.startsWith('/') ? text.split(/\s/)[0].split('@')[0] : ''),
          argument = text.split(/\s+/).slice(1).join(' ');
        const receiptContext = {
          tx,
          id,
          shop,
          customer,
          userId,
          owner,
          operational,
          now: this.now(),
          message: msg,
          say,
          emit: (method: TelegramMethod, payload: Record<string, unknown>) =>
            effect(method, payload),
          deliver: pendingDelivery,
          release,
          audit: (action: string) => this.audit(tx, id, action, userId),
        };
        if (web) {
          if (!owner || !operational)
            throw new HttpError(
              403,
              'OWNER_UNVERIFIED',
              'Responsável não confirmado ou loja indisponível.',
            );
          const review = /^admin:review-(approve|reject):([a-f0-9]{16}):(\d+)$/.exec(cmd);
          if (review) {
            const order = await tx.get(orderDoc(review[2]));
            if (
              !order ||
              order.status !== 'awaiting_review' ||
              order.receipt_revision !== Number(review[3]) ||
              order.expires_at <= this.now()
            )
              throw new HttpError(
                409,
                'RECEIPT_CHANGED',
                'Este pedido foi atualizado ou já analisado. Atualize a lista antes de continuar.',
              );
          }
          const notice = /^admin:notice-send:([a-f0-9]{12})$/.exec(cmd);
          if (notice) {
            const draft = await tx.get(path(id, 'announcements', notice[1]));
            if (
              !draft ||
              draft.status !== 'draft' ||
              !selling ||
              shop.notice_active ||
              !(shop.notice_subscribers ?? 0)
            )
              throw new HttpError(
                409,
                'NOTICE_NOT_READY',
                'Este aviso já foi enviado, há um envio em andamento ou não existem inscritos disponíveis.',
              );
          }
          this.audit(tx, id, 'store.command_web', web.uid);
        }
        if (walletScreen) {
          effect('sendMessage', {
            chat_id: chatId,
            text: walletScreen.text,
            reply_markup: walletScreen.markup,
          });
        } else if (await this.receipts.action(receiptContext, cmd)) {
          if (web?.reason && cmd.startsWith('admin:review-reject:'))
            await this.receipts.input(receiptContext, web.reason);
          saveCustomer();
        } else if (cmd === '/start' && /^owner_[A-Za-z0-9_-]{32}$/.test(argument)) {
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
        } else if (
          cmd === 'notices:subscribe' ||
          cmd === 'notices:unsubscribe' ||
          cmd === '/pararavisos'
        ) {
          const enabled = cmd === 'notices:subscribe';
          await this.notices.subscribe(tx, id, shop, userId, enabled);
          customer.notices = enabled;
          saveCustomer();
          say(
            enabled
              ? 'Você ativou os avisos desta loja. Pode parar a qualquer momento com /pararavisos.'
              : 'Você não receberá novos avisos desta loja. Seus pedidos e atendimento continuam disponíveis.',
            menu(),
          );
        } else if (cmd === '/paysupport' || cmd === '/suporte' || cmd === 'support') {
          const details = supportDetails(shop);
          effect('sendMessage', {
            chat_id: chatId,
            text: hasSupport(shop)
              ? details.text
              : 'Atendimento ainda não configurado pelo lojista. Guarde o número do seu pedido.',
            ...(details.url
              ? {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: shop.support_name || 'Falar com o suporte', url: details.url }],
                    ],
                  },
                }
              : {}),
          });
        } else if (cmd === '/help' || cmd === '/terms') {
          say(
            'Use /start para abrir a loja, /pedidos para acompanhar compras e /paysupport para ajuda com pagamentos. Produtos digitais são pagos em Telegram Stars. O estoque é reservado por 20 minutos e entregue após confirmação do Telegram. Não envie senhas ou dados de cartão ao bot.',
            menu(),
          );
        } else if (
          !operational &&
          (cmd === 'orders' || cmd === '/pedidos' || cmd.startsWith('history:'))
        ) {
          await listOrders(false, cmd.startsWith('history:') ? cmd.slice(8) : undefined);
        } else if (!operational && cmd.startsWith('order:')) {
          const order = (await tx.get(orderDoc(cmd.slice(6)))) as Order | null;
          if (order?.buyer_id === userId) say(orderSummary(order));
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
          const noticeContext = {
            tx,
            accountId: id,
            shop,
            customer,
            userId,
            owner,
            selling,
            message: msg,
            now: this.now(),
            say,
            emit: (method: TelegramMethod, payload: Record<string, unknown>) =>
              effect(method, payload),
            audit: (action: string) => this.audit(tx, id, action, userId),
          };
          if (await this.notices.action(noticeContext, action)) {
            // Announcement prompts and drafts are managed independently of orders.
          } else if (action === 'categories') {
            const categories = [
              ...new Set([...(shop.categories ?? []), ...shop.products.map((p) => p.category)]),
            ];
            say(
              'Escolha uma categoria para alterar seu emoji.',
              buttons([
                ...categories.map(
                  (name) =>
                    [
                      [
                        `${shop.category_emojis?.[name] ?? ''} ${name}`.trim(),
                        'admin:category:' + tokenHash(name).slice(0, 16),
                      ],
                    ] as [string, string][],
                ),
                [['Voltar', 'admin']],
              ]),
            );
          } else if (action.startsWith('category:')) {
            const name = [
              ...new Set([...(shop.categories ?? []), ...shop.products.map((p) => p.category)]),
            ].find((name) => tokenHash(name).slice(0, 16) === action.slice(9));
            if (name) {
              customer.session = { step: 'category_emoji', category: name };
              say(`Envie o emoji de ${name}, ou envie "remover" para deixar sem emoji.`);
              saveCustomer();
            }
          } else if (action === 'payment') {
            customer.session = null;
            say(
              `Modo atual: ${shop.payment_mode === 'manual' ? (shop.pix_mode === 'purincash' ? 'Pix automático · Blackout' : shop.pix_mode === 'mercadopago' ? 'Pix automático · Mercado Pago' : 'Pix/transferência com aprovação manual') : 'Telegram Stars'}.\n${['mercadopago', 'purincash'].includes(shop.pix_mode ?? '') ? 'Gerencie o Pix automático na aba Pagamentos do site.' : manualPixText(shop) || 'Dados de pagamento ainda não configurados.'}`,
              buttons([
                [['Dados Pix/transferência', 'admin:payment-details']],
                [
                  ['Usar Pix/transferência', 'admin:paymode:manual'],
                  ['Usar Stars', 'admin:paymode:stars'],
                ],
                [['Voltar', 'admin']],
              ]),
            );
          } else if (action === 'payment-details') {
            customer.session = { step: 'payment_instructions' };
            say(
              'Envie a chave Pix/dados de transferência e as orientações ao comprador (até 1000 caracteres). Só informe dados que devem aparecer no pagamento.',
            );
          } else if (action.startsWith('paymode:')) {
            const mode = action.slice(8);
            if (!['manual', 'stars'].includes(mode)) say('Modo inválido.');
            else if (shop.products.length || shop.recent_orders.length)
              say(
                'Não altere a moeda com catálogo ou pedidos existentes. Peça à equipe uma migração de preços.',
              );
            else {
              shop.payment_mode = mode as 'manual' | 'stars';
              shop.pix_mode = 'manual';
              say('Modo de pagamento atualizado.');
            }
          } else if (action === 'stats') {
            const s = stats(shop);
            say(
              `Estatísticas da loja\nPedidos criados: ${s.orders}\nCompras aprovadas: ${s.paid_orders}\nCompradores: ${s.buyers}\nEntregues: ${s.delivered_orders}\nAguardando comprovante/pagamento: ${shop.open_orders.length - (shop.review_orders?.length ?? 0)}\nComprovantes para aprovar: ${shop.review_orders?.length ?? 0}\nRecusados: ${s.rejected_orders}\nVendas aprovadas: ${isoMoney(s.gross_brl, 'BRL')} · ${isoMoney(s.gross_stars, 'XTR')}`,
              adminMenu(),
            );
          } else if (action.startsWith('buyers:') && !/^\d{0,16}$/.test(action.slice(7))) {
            say('Página de compradores inválida.');
          } else if (action.startsWith('buyers:')) {
            const buyers = await this.store.list(root(id) + '/buyers', {
              limit: 13,
              afterId: action.slice(7),
            });
            say(
              buyers.length ? 'Compradores:' : 'Ainda não há compras aprovadas.',
              buttons([
                ...buyers
                  .slice(0, 12)
                  .map(
                    (b) =>
                      [[`${b.name} · ${b.paid_orders} compra(s)`, `admin:buyer:${b.id}`]] as [
                        string,
                        string,
                      ][],
                  ),
                ...(buyers.length > 12
                  ? [[['Mais compradores', 'admin:buyers:' + buyers[11].id]] as [string, string][]]
                  : []),
                [['Voltar', 'admin']],
              ]),
            );
          } else if (action.startsWith('buyer:')) {
            const buyer = await tx.get(path(id, 'buyers', action.slice(6)));
            say(buyer ? buyerSummary(buyer) : 'Comprador não encontrado.');
          } else if (action === 'pending') await listOrders(true, undefined, true);
          else if (action.startsWith('history:')) await listOrders(true, action.slice(8));
          else if (action === 'new') {
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
                [['🖼 Foto do produto', `admin:productbanner:${pid}`]],
                [['Ativar/desativar', `admin:toggle:${pid}`]],
              ]),
            );
          } else if (action.startsWith('productbanner:')) {
            customer.session = { step: 'product_banner', product: action.slice(14) };
            say(
              'Envie uma foto para este produto, ou remover para exibi-lo só em texto. A imagem é opcional.',
            );
          } else if (action === 'support') {
            customer.session = { step: 'support' };
            say(
              `${supportDetails(shop).text}\n\nVocê pode enviar seu @usuario ou escolher o campo que deseja alterar.`,
              buttons([
                [
                  ['Nome', 'admin:support-name'],
                  ['Telefone', 'admin:support-phone'],
                ],
                [
                  ['Link de atendimento', 'admin:support-url'],
                  ['Usuário Telegram', 'admin:support-handle'],
                ],
                [['Voltar', 'admin']],
              ]),
            );
          } else if (
            ['support-name', 'support-phone', 'support-url', 'support-handle'].includes(action)
          ) {
            customer.session = {
              step: action === 'support-handle' ? 'support' : action.replace('-', '_'),
            };
            say(
              action === 'support-name'
                ? 'Envie o nome do suporte (até 80 caracteres), ou remover.'
                : action === 'support-phone'
                  ? 'Envie o telefone com DDD/código do país, ou remover.'
                  : action === 'support-url'
                    ? 'Envie o link HTTPS de atendimento (Telegram, WhatsApp ou seu site), ou remover.'
                    : 'Envie o @usuario do suporte, ou remover.',
            );
          } else if (action.startsWith('field:')) {
            const [, field, pid] = action.split(':');
            customer.session = { step: 'edit', field, product: pid };
            say(
              field === 'price'
                ? shop.payment_mode === 'manual'
                  ? 'Envie o novo preço em reais, como 12,50.'
                  : 'Envie o novo preço inteiro em Stars.'
                : 'Envie o novo valor.',
            );
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
                orderSummary(o, true),
                buttons([
                  ...(o.receipt_ciphertext
                    ? [[['Ver comprovante', `admin:proof:${o.id}`]] as [string, string][]]
                    : []),
                  ...(['paid', 'delivered'].includes(o.status)
                    ? [
                        [['Reentregar (confirmar)', `admin:redeliver:${o.id}`]] as [
                          string,
                          string,
                        ][],
                      ]
                    : []),
                  ...(o.charge_id
                    ? [
                        [['Reembolsar Stars (confirmar)', `admin:refund:${o.id}`]] as [
                          string,
                          string,
                        ][],
                      ]
                    : []),
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
          const noticeContext = {
            tx,
            accountId: id,
            shop,
            customer,
            userId,
            owner,
            selling,
            message: msg,
            now: this.now(),
            say,
            emit: (method: TelegramMethod, payload: Record<string, unknown>) =>
              effect(method, payload),
            audit: (action: string) => this.audit(tx, id, action, userId),
          };
          if (await this.receipts.input(receiptContext, text)) {
            // Receipt submission never approves its own payment.
          } else if (await this.notices.input(noticeContext, text)) {
            // Input changes a draft; sending still requires its explicit button.
          } else if (session.step === 'coupon') {
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
              say(
                shop.payment_mode === 'manual'
                  ? 'Qual é o preço em reais? Exemplo: 12,50.'
                  : 'Qual é o preço inteiro em Telegram Stars?',
              );
            }
          } else if (session.step === 'product_price') {
            const price = parsePrice(text, shop.payment_mode === 'manual');
            if (price === null)
              say(
                shop.payment_mode === 'manual'
                  ? 'Envie um valor válido em reais, como 12,50.'
                  : 'Envie um número inteiro de 1 a 1000000.',
              );
            else {
              customer.session = { ...session, step: 'product_category', price };
              say('Qual é a categoria do produto (até 40 caracteres)?');
            }
          } else if (session.step === 'category_emoji') {
            const parsed = categoryEmoji.safeParse(text.toLowerCase() === 'remover' ? '' : text);
            const exists = [
              ...(shop.categories ?? []),
              ...shop.products.map((p) => p.category),
            ].includes(session.category);
            if (!exists) {
              customer.session = null;
              say('Categoria removida. Escolha outra categoria.', adminMenu());
            } else if (!parsed.success) say('Envie um único emoji ou escreva "remover".');
            else {
              shop.category_emojis = { ...shop.category_emojis, [session.category]: parsed.data };
              customer.session = null;
              say('Emoji da categoria atualizado.', adminMenu());
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
          } else if (session.step === 'payment_instructions') {
            if (!text || text.length > 1000) say('Envie de 1 a 1000 caracteres.');
            else {
              shop.payment_instructions = text;
              customer.session = null;
              say('Dados de pagamento atualizados.', adminMenu());
            }
          } else if (session.step === 'welcome') {
            if (!text || text.length > 600) say('Use de 1 a 600 caracteres.');
            else {
              shop.welcome = text;
              customer.session = null;
              say('Mensagem atualizada.', adminMenu());
            }
          } else if (session.step === 'support') {
            if (!/^@[A-Za-z0-9_]{5,32}$/.test(text) && text.toLowerCase() !== 'remover')
              say('Envie um @usuario válido, ou remover.');
            else {
              shop.support = text.toLowerCase() === 'remover' ? '' : text;
              customer.session = null;
              say('Atendimento atualizado.', adminMenu());
            }
          } else if (['support_name', 'support_phone', 'support_url'].includes(session.step)) {
            const remove = text.toLowerCase() === 'remover';
            let value = remove ? '' : text;
            const valid =
              remove ||
              (session.step === 'support_name'
                ? Boolean(text) && text.length <= 80
                : session.step === 'support_phone'
                  ? /^[+\d ()-]{7,32}$/.test(text) &&
                    text.replace(/\D/g, '').length >= 7 &&
                    text.replace(/\D/g, '').length <= 15
                  : Boolean(supportUrl(text)));
            if (!valid)
              say(
                session.step === 'support_url'
                  ? 'Use um endereço HTTPS válido, sem login ou senha na URL.'
                  : session.step === 'support_phone'
                    ? 'Envie um telefone válido, com 7 a 15 dígitos.'
                    : 'Use de 1 a 80 caracteres.',
              );
            else {
              if (session.step === 'support_url' && !remove) value = supportUrl(text)!;
              (shop as unknown as Doc)[session.step] = value;
              customer.session = null;
              say('Suporte atualizado.', adminMenu());
            }
          } else if (session.step === 'product_banner') {
            const product = shop.products.find((p) => p.id === session.product),
              photo = msg.photo?.at(-1);
            if (!product) {
              customer.session = null;
              say('Produto não encontrado.');
            } else if (photo || text.toLowerCase() === 'remover') {
              product.banner = photo?.file_id ?? '';
              customer.session = null;
              say(
                photo ? 'Foto do produto atualizada.' : 'O produto será exibido só em texto.',
                adminMenu(),
              );
            } else say('Envie uma foto ou remover.');
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
              const price = parsePrice(text, shop.payment_mode === 'manual');
              if (price === null) say('Preço inválido.');
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
        } else if (cmd.startsWith('watch:')) {
          const p = shop.products.find((v) => v.id === cmd.slice(6) && v.enabled);
          if (!p) say('Produto indisponível.');
          else if (p.stock > 0) showProduct(p);
          else
            say(
              `${p.title} está sem estoque. Quer receber um aviso quando voltar?`,
              buttons([
                [
                  ['Sim, avisar', 'watch-on:' + p.id],
                  ['Não', 'watch-off:' + p.id],
                ],
                [['Voltar ao produto', 'p:' + p.id]],
              ]),
            );
        } else if (cmd.startsWith('watch-on:') || cmd.startsWith('watch-off:')) {
          const on = cmd.startsWith('watch-on:'),
            pid = cmd.slice(on ? 9 : 10),
            p = shop.products.find((v) => v.id === pid && v.enabled);
          if (!p || (on && !selling)) say('Produto indisponível.');
          else if (on && p.stock > 0) showProduct(p);
          else {
            const wid = pid + '_' + userId,
              target = path(id, 'stock_watchers', wid),
              previous = await tx.get(target);
            tx.set(target, {
              id: wid,
              user_id: userId,
              product_id: pid,
              active: on,
              cancelled: !on,
              nonce: on && previous?.active ? previous.nonce : randomUUID(),
              requested_at: this.now(),
            });
            say(
              on
                ? 'Pronto. Você receberá um aviso quando este produto voltar ao estoque.'
                : 'Tudo bem. Não enviaremos aviso deste produto.',
              buttons([
                [
                  ['Voltar à categoria', 'cat:' + tokenHash(p.category).slice(0, 16)],
                  ['Carrinho', 'cart'],
                ],
              ]),
            );
          }
        } else if (cmd.startsWith('cat:')) {
          const categories = [
              ...new Set(shop.products.filter((p) => p.enabled).map((p) => p.category)),
            ].sort(),
            category = /^\d{1,2}$/.test(cmd.slice(4))
              ? categories[Number(cmd.slice(4))]
              : categories.find((name) => tokenHash(name).slice(0, 16) === cmd.slice(4));
          if (!selling && !owner) say('A loja ainda não está recebendo pedidos.');
          else if (category) catalog(category);
          else catalog();
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
          else if (!p?.stock) {
            if (p) showProduct(p);
            else say('Produto indisponível.');
          } else {
            const current = customer.items.find((v: any) => v.id === p.id);
            if (customer.items.reduce((s: number, v: any) => s + v.quantity, 0) >= 10)
              say('Limite de 10 unidades por pedido.');
            else if (current && current.quantity >= p.stock)
              say(
                'Seu carrinho já contém todas as unidades disponíveis.',
                buttons([
                  [
                    ['Carrinho', 'cart'],
                    ['Voltar', 'cat:' + tokenHash(p.category).slice(0, 16)],
                  ],
                ]),
              );
            else {
              if (current) current.quantity++;
              else customer.items.push({ id: p.id, quantity: 1 });
              saveCustomer();
              const ack = effects.find((e) => e.method === 'answerCallbackQuery');
              if (ack) ack.payload.text = 'Adicionado ao carrinho.';
              catalog(p.category);
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
        } else if (cmd === 'checkout' || cmd.startsWith('buy:')) {
          const direct = cmd.startsWith('buy:'),
            checkoutItems = direct ? [{ id: cmd.slice(4), quantity: 1 }] : customer.items;
          const checkoutCoupon = direct ? '' : customer.coupon;
          if (!selling) say('A loja não está recebendo novos pedidos.');
          else if (!hasSupport(shop))
            say('O lojista precisa configurar o atendimento antes de receber pagamentos.');
          else if (
            shop.payment_mode === 'manual' &&
            shop.pix_mode === 'mercadopago' &&
            (!shop.mp_connection || !this.checkoutOrigin)
          )
            say('O lojista precisa conectar o Mercado Pago antes de receber Pix automático.');
          else if (
            shop.payment_mode === 'manual' &&
            shop.pix_mode === 'purincash' &&
            (!shop.purin_connection || !shop.purin_subaccount || !this.checkoutOrigin)
          )
            say('A Blackout precisa vincular a subconta antes de receber Pix automático.');
          else if (
            shop.payment_mode === 'manual' &&
            !['mercadopago', 'purincash'].includes(shop.pix_mode ?? '') &&
            !manualPixText(shop)
          )
            say('O lojista ainda precisa configurar os dados de pagamento.');
          else if (!checkoutItems.length) say('Adicione um produto ao carrinho.');
          else if (shop.open_orders.length >= 25)
            say('Há muitos pedidos em andamento. Aguarde alguns minutos.');
          else {
            const coupon = checkoutCoupon ? shop.coupons[checkoutCoupon] : null;
            const reservation: Order['items'] = [];
            let total = 0,
              valid = !checkoutCoupon || Boolean(coupon && coupon.used < coupon.limit);
            for (const item of checkoutItems) {
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
                now = this.now(),
                automaticPix =
                  shop.payment_mode === 'manual' &&
                  ['mercadopago', 'purincash'].includes(shop.pix_mode ?? ''),
                checkoutKey = automaticPix ? randomBytes(32).toString('base64url') : '';
              const order: Order = {
                id: oid,
                buyer_id: userId,
                buyer_name: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || userId,
                buyer_username: from?.username ?? '',
                currency: shop.payment_mode === 'manual' ? 'BRL' : 'XTR',
                payment_method: automaticPix
                  ? (shop.pix_mode as 'mercadopago' | 'purincash')
                  : shop.payment_mode === 'manual'
                    ? 'manual'
                    : 'stars',
                ...(automaticPix
                  ? {
                      checkout_token_hash: tokenHash(checkoutKey),
                      ...(shop.pix_mode === 'purincash'
                        ? {
                            purin_connection: shop.purin_connection,
                            purin_subaccount: shop.purin_subaccount,
                          }
                        : { mp_connection: shop.mp_connection }),
                    }
                  : {}),
                items: reservation,
                total,
                coupon: checkoutCoupon,
                created_at: now,
                expires_at: new Date(now.getTime() + (automaticPix ? 60 : 20) * 60000),
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
              stats(shop).orders++;
              customer.orders = [oid, ...customer.orders].slice(0, 30);
              if (!direct) {
                customer.items = [];
                customer.coupon = '';
              }
              saveCustomer();
              if (automaticPix) {
                effect('sendMessage', {
                  chat_id: chatId,
                  text: `${orderSummary(order)}\n\nPix automático · ${shop.pix_mode === 'purincash' ? 'Blackout' : 'Mercado Pago'}\nAbra o pagamento seguro para gerar o QR Code e o copia e cola. A entrega será liberada após a confirmação do pagamento.`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: '💠 Gerar Pix',
                          url: `${this.checkoutOrigin}/#/pagar/${id}/${oid}/${checkoutKey}`,
                        },
                      ],
                      [{ text: '🔄 Verificar pagamento', callback_data: 'pix-check:' + oid }],
                    ],
                  },
                });
              } else if (shop.payment_mode === 'manual') {
                const single =
                  reservation.length === 1 && reservation[0].quantity === 1
                    ? shop.products.find((p) => p.id === reservation[0].product_id)
                    : undefined;
                const qr =
                  !order.coupon && single?.pix_qr && single.pix_qr_price === order.total
                    ? single.pix_qr
                    : '';
                const markup = buttons([
                  [['📎 Enviar comprovante', 'receipt:' + oid]],
                  [
                    ['🧾 Meus pedidos', 'orders'],
                    ['✖️ Cancelar pedido', 'cancel:' + oid],
                  ],
                ]);
                if (qr)
                  effect('sendPhoto', {
                    chat_id: chatId,
                    photo: qr,
                    caption: `${orderSummary(order)}\n\nPix · confira o valor e o recebedor no seu banco antes de pagar.\nEnvie o comprovante pelo botão abaixo. A entrega depende da aprovação do lojista.`,
                    reply_markup: markup,
                  });
                else
                  say(
                    `${orderSummary(order)}\n\nPix/transferência\n${manualPixText(shop)}\n\nEnvie o comprovante pelo botão abaixo. A entrega depende da aprovação do lojista.`,
                    markup,
                  );
              } else
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
                `Pedido ${oid}. Estoque reservado por ${automaticPix ? 60 : 20} minutos.`,
                buttons([[['Cancelar pedido', 'cancel:' + oid]]]),
              );
              this.audit(tx, id, 'bot_order.created', userId);
            }
          }
        } else if (cmd.startsWith('pix-check:')) {
          const order = (await tx.get(orderDoc(cmd.slice(10)))) as Order | null;
          if (
            order?.buyer_id === userId &&
            ['mercadopago', 'purincash'].includes(order.payment_method ?? '')
          )
            say(
              `Pedido ${order.id}: ${orderLabels[order.status]}. A confirmação é consultada no sistema de pagamento; acompanhe também em Meus pedidos.`,
            );
          else say('Pedido não encontrado.');
        } else if (cmd.startsWith('history:')) await listOrders(false, cmd.slice(8));
        else if (cmd === 'orders' || cmd === '/pedidos') await listOrders();
        else if (cmd.startsWith('order:')) {
          const o = (await tx.get(orderDoc(cmd.slice(6)))) as Order | null;
          if (o && o.buyer_id === userId)
            say(
              orderSummary(o),
              buttons([
                ...(o.payment_method === 'manual' &&
                ['awaiting_payment', 'awaiting_review'].includes(o.status)
                  ? [[['Enviar/atualizar comprovante', 'receipt:' + o.id]] as [string, string][]]
                  : []),
                [['Voltar', 'orders']],
              ]),
            );
          else say('Pedido não encontrado.');
        } else if (cmd.startsWith('cancel:')) {
          const o = (await tx.get(orderDoc(cmd.slice(7)))) as Order | null;
          if (o && o.buyer_id === userId && o.status === 'awaiting_payment') {
            await release(o, 'cancelled');
            say('Pedido cancelado e estoque liberado.', menu());
          } else say('Este pedido não pode ser cancelado aqui. Use /paysupport.');
        } else {
          const welcome = `${shop.title}\n\n${shop.welcome}${!selling ? '\n\nLoja em configuração ou temporariamente sem novas vendas.' : ''}`;
          if (shop.banner)
            effect('sendPhoto', {
              chat_id: chatId,
              photo: shop.banner,
              caption: welcome,
              reply_markup: menu(),
            });
          else say(welcome, menu());
        }
      }
      if (!web) reuseNavigationMessage(update, effects);
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
      if (!web)
        tx.set('bot_runtimes/' + id, {
          ...runtime,
          offset: update.update_id + 1,
          last_update_at: this.now(),
          last_seen: this.now(),
        });
      return { effectIds, duplicate: false };
    });
  }

  async tick(auth: RuntimeAccess, botName?: string) {
    const result = await buffered(this.store, async (tx) => {
      const { runtime, account, setup, shop } = await this.access(tx, auth);
      if (botName && botName !== shop.title) {
        shop.title = botName;
        tx.set(root(auth.accountId), shop);
      }
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
    await queueStockAlerts(this.store, this.vault, auth, this.now());
    return result;
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
    await this.notices.pump(auth);
    const [pending, sending] = await Promise.all(
      ['pending', 'sending'].map((status) =>
        this.store.list(root(auth.accountId) + '/effects', {
          limit: 50,
          equals: ['status', status],
        }),
      ),
    );
    // A crashed sender's expired lease must be reconciled, without resending.
    return [
      ...pending.filter((v) => !v.announcement_id),
      ...pending.filter((v) => v.announcement_id),
      ...sending,
    ].map((v) => v.id as string);
  }
  async claim(auth: RuntimeAccess, effectId: string) {
    return buffered(this.store, async (tx) => {
      const { account, setup, shop } = await this.access(tx, auth),
        target = path(auth.accountId, 'effects', effectId),
        out = (await tx.get(target)) as (BotEffect & { lease_at?: Date }) | null;
      if (!out || !['pending', 'sending'].includes(out.status)) return null;
      if (out.wallet_draft_id && out.status === 'pending') {
        const draft = await tx.get(
          'merchant_wallets/' + auth.accountId + '/withdrawals/' + out.wallet_draft_id,
        );
        if (
          !draft ||
          !['prepared', 'awaiting_confirmation'].includes(draft.status) ||
          draft.expires_at <= this.now()
        ) {
          tx.set(target, { ...out, status: 'skipped', finished_at: this.now() });
          return null;
        }
      }
      if (out.stock_watch_id) {
        const watch = await tx.get(path(auth.accountId, 'stock_watchers', out.stock_watch_id));
        if (!watch || watch.cancelled || watch.nonce !== out.stock_watch_nonce) {
          tx.set(target, { ...out, status: 'skipped', finished_at: this.now() });
          return null;
        }
        if (
          account.access_status !== 'approved' ||
          setup.activation_status !== 'active' ||
          account.paid_through <= this.now()
        )
          return null;
      }
      if (out.status === 'sending') {
        if (out.lease_at && this.now().getTime() - out.lease_at.getTime() > 120000) {
          tx.set(target, { ...out, status: 'uncertain' });
          await this.notices.finish(tx, auth, shop, out, 'uncertain');
        }
        return null;
      }
      const raw = out as unknown as Doc;
      if (raw.next_attempt_at && raw.next_attempt_at > this.now()) return null;
      if (
        out.announcement_id &&
        (!(
          account.access_status === 'approved' &&
          setup.activation_status === 'active' &&
          account.paid_through > this.now()
        ) ||
          !(await this.notices.canSend(tx, auth, shop, out)))
      ) {
        tx.set(target, { ...out, status: 'skipped', finished_at: this.now() });
        await this.notices.finish(tx, auth, shop, out, 'skipped');
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
        ...(out.announcement_id ? { announcement_id: out.announcement_id } : {}),
      };
    });
  }
  async acknowledge(
    auth: RuntimeAccess,
    effectId: string,
    lease: string,
    result: 'sent' | 'uncertain' | 'failed' | 'retry',
    errorCode?: number,
    retryAfter = 0,
  ) {
    return buffered(this.store, async (tx) => {
      const { shop } = await this.access(tx, auth);
      const target = path(auth.accountId, 'effects', effectId),
        out = (await tx.get(target)) as BotEffect | null;
      if (!out || out.status !== 'sending' || out.lease !== lease)
        throw new HttpError(409, 'EFFECT_LEASE_INVALID', 'Confirmação de envio inválida.');
      if (result === 'retry') {
        tx.set(target, {
          ...out,
          status: 'pending',
          next_attempt_at: new Date(
            this.now().getTime() + Math.max(1, Math.min(86400, retryAfter)) * 1000,
          ),
        });
        return;
      }
      tx.set(target, { ...out, status: result, finished_at: this.now() });
      await this.notices.finish(tx, auth, shop, out, result, errorCode);
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
            if (!order.fulfilled_at) {
              order.fulfilled_at = this.now();
              stats(shop).delivered_orders++;
              tx.set(root(auth.accountId), shop);
            }
            tx.set(path(auth.accountId, 'orders', order.id), order);
          }
        }
      }
    });
  }
}
