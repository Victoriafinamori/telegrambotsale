import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DocumentStore, DocumentTransaction, Doc } from './document-store.js';
import type { Shop, Product, Order, Announcement } from './bot-types.js';
import { botRoot, botPath, botTransaction } from './bot-data.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { supportUrl } from './bot-appearance.js';
import { stats } from './bot-orders.js';
import { categoryEmoji } from './category-emoji.js';
import type { BotStore } from './bot-store.js';
import { TelegramClient } from './telegram-client.js';
import { setupProgress } from './setup-progress.js';

const asset = z
  .string()
  .max(512)
  .refine((v) => !v || /^[A-Za-z0-9_-]+$/.test(v));
export const productInput = z
  .object({
    id: z
      .string()
      .regex(/^[a-f0-9]{12}$/)
      .optional(),
    title: z.string().trim().min(1).max(70),
    description: z.string().trim().min(1).max(400),
    category: z.string().trim().min(1).max(40),
    price: z.number().int().min(1).max(10000000),
    enabled: z.boolean(),
    banner: asset,
    pix_qr: asset.optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const settingsInput = z
  .object({
    welcome: z.string().trim().min(1).max(600),
    banner: asset,
    support: z.string().refine((v) => !v || /^@[A-Za-z0-9_]{5,32}$/.test(v)),
    support_name: z.string().trim().max(80),
    support_phone: z
      .string()
      .trim()
      .refine(
        (v) =>
          !v ||
          (/^[+\d ()-]{7,32}$/.test(v) &&
            v.replace(/\D/g, '').length >= 7 &&
            v.replace(/\D/g, '').length <= 15),
      ),
    support_url: z.string().refine((v) => !v || Boolean(supportUrl(v))),
    payment_instructions: z.string().trim().max(1000),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const orderPublic = (order: Doc) => {
  const {
    items,
    receipt_ciphertext,
    checkout_token_hash,
    mp_connection,
    purin_connection,
    purin_subaccount,
    ...meta
  } = order;
  return {
    ...meta,
    hasReceipt: Boolean(receipt_ciphertext),
    items: items.map((item: Doc) => ({
      product_id: item.product_id,
      title: item.title,
      quantity: item.quantity,
    })),
  };
};
export class MerchantConsole {
  private vault: SecretVault;
  constructor(
    readonly store: DocumentStore,
    key: string,
    private bots: BotStore,
  ) {
    this.vault = new SecretVault(key);
  }
  private async owner(tx: DocumentTransaction, id: string, uid: string) {
    const [account, setup, shop] = await Promise.all([
      tx.get('merchant_accounts/' + id),
      tx.get('merchant_bot_setup/' + id),
      tx.get(botRoot(id)) as Promise<Shop | null>,
    ]);
    if (!account || account.firebase_uid !== uid || account.access_status !== 'approved')
      throw new HttpError(
        403,
        'STORE_NOT_APPROVED',
        'Sua loja não está liberada para configuração.',
      );
    if (!shop || !setup?.submitted_at)
      throw new HttpError(409, 'STORE_NOT_READY', 'A equipe ainda precisa preparar a loja.');
    return { shop, account, setup };
  }
  private audit(tx: DocumentTransaction, id: string, uid: string, action: string) {
    const event = randomUUID();
    tx.set('platform_audit/' + event, {
      id: event,
      actor_uid: uid,
      account_id: id,
      action,
      subject_uid: null,
      created_at: new Date(),
    });
  }
  private revision(shop: Shop, expected: number) {
    if ((shop.portal_revision ?? 0) !== expected)
      throw new HttpError(
        409,
        'STORE_CHANGED',
        'A loja foi atualizada em outra tela. Atualize antes de salvar novamente.',
      );
  }
  async read(id: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      const { shop, setup } = await this.owner(tx, id, uid);
      return {
        title: shop.title,
        welcome: shop.welcome,
        banner: shop.banner,
        products: shop.products,
        category_emojis: shop.category_emojis ?? {},
        categories: [
          ...new Set([...(shop.categories ?? []), ...shop.products.map((p) => p.category)]),
        ].sort((a, b) => a.localeCompare(b, 'pt-BR')),
        support: shop.support,
        support_name: shop.support_name ?? '',
        support_phone: shop.support_phone ?? '',
        support_url: shop.support_url ?? '',
        payment_mode: shop.payment_mode ?? 'stars',
        payment_instructions: shop.payment_instructions ?? '',
        coupons: shop.coupons,
        stats: stats(shop),
        pendingReview: shop.review_orders?.length ?? 0,
        pendingPayment: shop.open_orders.length - (shop.review_orders?.length ?? 0),
        noticeSubscribers: shop.notice_subscribers ?? 0,
        revision: shop.portal_revision ?? 0,
        botUsername: setup.bot_username,
        setupProgress: await setupProgress(tx, id, uid),
      };
    });
  }
  async saveSettings(id: string, uid: string, input: unknown) {
    const value = settingsInput.parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      const { revision, ...fields } = value;
      tx.set(botRoot(id), { ...shop, ...fields, portal_revision: revision + 1 });
      this.audit(tx, id, uid, 'store.settings_saved_web');
    });
  }
  async saveProduct(id: string, uid: string, input: unknown) {
    const value = productInput.parse(input);
    return botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      if (shop.payment_mode !== 'manual' && value.price > 1000000)
        throw new HttpError(400, 'PRICE_INVALID', 'Preço em Stars fora do limite.');
      const pid = value.id ?? randomBytes(6).toString('hex'),
        current = shop.products.find((p) => p.id === pid);
      if (value.id && !current)
        throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      if (!current && shop.products.length >= 40)
        throw new HttpError(409, 'PRODUCT_LIMIT', 'Limite de 40 produtos atingido.');
      const { revision, ...fields } = value,
        qr = value.pix_qr ?? current?.pix_qr ?? '',
        product: Product = {
          ...fields,
          id: pid,
          stock: current?.stock ?? 0,
          pix_qr: qr,
          pix_qr_price: qr && qr !== current?.pix_qr ? value.price : (current?.pix_qr_price ?? 0),
        };
      if (current) shop.products = shop.products.map((p) => (p.id === pid ? product : p));
      else {
        shop.products.push(product);
        tx.set(botPath(id, 'products', pid), { id: pid, units: [] });
      }
      tx.set(botRoot(id), { ...shop, portal_revision: revision + 1 });
      this.audit(tx, id, uid, 'store.product_saved_web');
      return { id: pid };
    });
  }
  async createCategory(id: string, uid: string, input: unknown) {
    const value = z
      .object({
        name: z.string().trim().min(1).max(40),
        emoji: categoryEmoji.optional(),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      const categories = [
        ...new Set([...(shop.categories ?? []), ...shop.products.map((p) => p.category)]),
      ];
      if (!categories.includes(value.name)) {
        if (categories.length >= 40)
          throw new HttpError(409, 'CATEGORY_LIMIT', 'Limite de 40 categorias atingido.');
        categories.push(value.name);
      }
      tx.set(botRoot(id), {
        ...shop,
        categories,
        category_emojis: {
          ...shop.category_emojis,
          ...(value.emoji !== undefined ? { [value.name]: value.emoji } : {}),
        },
        portal_revision: value.revision + 1,
      });
      this.audit(tx, id, uid, 'store.category_created_web');
    });
  }
  async manageCategory(id: string, uid: string, input: unknown) {
    const name = z.string().trim().min(1).max(40),
      revision = z.number().int().nonnegative();
    const value = z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('rename'),
            name,
            newName: name,
            emoji: categoryEmoji.optional(),
            revision,
          })
          .strict(),
        z
          .object({ action: z.literal('delete'), name, destination: name.optional(), revision })
          .strict(),
      ])
      .parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      const categories = [
        ...new Set([...(shop.categories ?? []), ...shop.products.map((p) => p.category)]),
      ];
      if (!categories.includes(value.name))
        throw new HttpError(
          404,
          'CATEGORY_NOT_FOUND',
          'Categoria não encontrada. Atualize o catálogo.',
        );
      if (value.action === 'rename') {
        if (value.newName !== value.name && categories.includes(value.newName))
          throw new HttpError(409, 'CATEGORY_EXISTS', 'Já existe uma categoria com esse nome.');
        shop.categories = categories.map((category) =>
          category === value.name ? value.newName : category,
        );
        shop.products = shop.products.map((p) =>
          p.category === value.name ? { ...p, category: value.newName } : p,
        );
        const emoji = value.emoji ?? shop.category_emojis?.[value.name] ?? '';
        shop.category_emojis = {
          ...Object.fromEntries(
            Object.entries(shop.category_emojis ?? {}).filter(([key]) => key !== value.name),
          ),
          [value.newName]: emoji,
        };
      } else {
        const hasProducts = shop.products.some((p) => p.category === value.name);
        if (
          hasProducts &&
          (!value.destination ||
            value.destination === value.name ||
            !categories.includes(value.destination))
        )
          throw new HttpError(
            409,
            'CATEGORY_HAS_PRODUCTS',
            'Escolha outra categoria para receber os produtos antes de excluir.',
          );
        shop.categories = categories.filter((category) => category !== value.name);
        shop.category_emojis = Object.fromEntries(
          Object.entries(shop.category_emojis ?? {}).filter(([key]) => key !== value.name),
        );
        if (hasProducts)
          shop.products = shop.products.map((p) =>
            p.category === value.name ? { ...p, category: value.destination! } : p,
          );
      }
      tx.set(botRoot(id), { ...shop, portal_revision: value.revision + 1 });
      this.audit(
        tx,
        id,
        uid,
        value.action === 'rename' ? 'store.category_renamed_web' : 'store.category_deleted_web',
      );
    });
  }
  async moveProduct(id: string, uid: string, input: unknown) {
    const value = z
      .object({
        productId: z.string().regex(/^[a-f0-9]{12}$/),
        direction: z.enum(['up', 'down']),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      this.revision(shop, value.revision);
      const index = shop.products.findIndex((p) => p.id === value.productId);
      if (index < 0) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      const positions = shop.products.flatMap((p, i) =>
        p.category === shop.products[index].category ? [i] : [],
      );
      const position = positions.indexOf(index),
        target = positions[position + (value.direction === 'up' ? -1 : 1)];
      if (target === undefined) return;
      [shop.products[index], shop.products[target]] = [shop.products[target], shop.products[index]];
      tx.set(botRoot(id), { ...shop, portal_revision: value.revision + 1 });
      this.audit(tx, id, uid, 'store.product_reordered_web');
    });
  }
  async addStock(id: string, uid: string, input: unknown) {
    const value = z
      .object({
        productId: z.string().regex(/^[a-f0-9]{12}$/),
        units: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
        requestId: z.uuid(),
      })
      .strict()
      .parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid),
        receipt = botPath(id, 'stock_requests', value.requestId);
      if (await tx.get(receipt)) return;
      const p = shop.products.find((p) => p.id === value.productId),
        target = botPath(id, 'products', value.productId),
        stock = await tx.get(target);
      if (!p || !stock) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      if (stock.units.length + value.units.length > 100)
        throw new HttpError(409, 'STOCK_LIMIT', 'Limite de 100 unidades disponíveis por produto.');
      for (const text of value.units) {
        const unit = randomBytes(8).toString('hex');
        stock.units.push({
          id: unit,
          ciphertext: this.vault.seal(
            JSON.stringify({ kind: 'text', text }),
            `${id}:stock:${p.id}:${unit}`,
          ),
        });
      }
      p.stock = stock.units.length;
      tx.set(target, stock);
      tx.set(botRoot(id), { ...shop, portal_revision: (shop.portal_revision ?? 0) + 1 });
      tx.set(receipt, { created_at: new Date() });
      this.audit(tx, id, uid, 'store.stock_added_web');
    });
  }
  async coupon(id: string, uid: string, input: unknown) {
    const value = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{3,20}$/),
        percent: z.number().int().min(1).max(90),
        limit: z.number().int().min(1).max(99999),
      })
      .strict()
      .parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      if (shop.coupons[value.code])
        throw new HttpError(409, 'COUPON_EXISTS', 'Esse cupom já existe.');
      if (Object.keys(shop.coupons).length >= 20)
        throw new HttpError(409, 'COUPON_LIMIT', 'Limite de 20 cupons.');
      shop.coupons[value.code] = { percent: value.percent, limit: value.limit, used: 0 };
      tx.set(botRoot(id), { ...shop, portal_revision: (shop.portal_revision ?? 0) + 1 });
      this.audit(tx, id, uid, 'store.coupon_created_web');
    });
  }
  async orders(id: string, uid: string, cursor = '', pending = false) {
    return botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      if (pending) {
        const orders = await Promise.all(
          (shop.review_orders ?? []).map((oid) => tx.get(botPath(id, 'orders', oid))),
        );
        return { orders: orders.filter(Boolean).map((o) => orderPublic(o!)), next: null };
      }
      const orders = await this.store.list(botRoot(id) + '/orders', { limit: 21, afterId: cursor });
      return {
        orders: orders.slice(0, 20).map(orderPublic),
        next: orders.length > 20 ? orders[19].id : null,
      };
    });
  }
  async notices(id: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid);
      const list = await Promise.all(
        (shop.notice_recent ?? []).map((nid) => tx.get(botPath(id, 'announcements', nid))),
      );
      return list.filter(Boolean);
    });
  }
  async draft(id: string, uid: string, input: unknown) {
    const value = z
      .object({ text: z.string().trim().min(1).max(900), photo: asset, requestId: z.uuid() })
      .strict()
      .parse(input);
    return botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid),
        dedup = botPath(id, 'notice_requests', value.requestId),
        existing = await tx.get(dedup);
      if (existing) return { id: existing.notice_id };
      const nid = randomBytes(6).toString('hex'),
        notice: Announcement = {
          id: nid,
          text: value.text,
          photo: value.photo,
          status: 'draft',
          created_at: new Date(),
          audience_at: null,
          cursor: '',
          scan_complete: false,
          queued: 0,
          sent: 0,
          failed: 0,
          uncertain: 0,
          skipped: 0,
        };
      tx.set(botPath(id, 'announcements', nid), notice);
      shop.notice_recent = [nid, ...(shop.notice_recent ?? [])].slice(0, 10);
      tx.set(botRoot(id), shop);
      tx.set(dedup, { notice_id: nid });
      this.audit(tx, id, uid, 'bot_notice.draft_created_web');
      return { id: nid };
    });
  }
  async command(id: string, uid: string, input: unknown) {
    const value = z
      .object({
        command: z.string().max(64),
        requestId: z.uuid(),
        reason: z.string().trim().min(3).max(300).optional(),
      })
      .strict()
      .parse(input);
    await botTransaction(this.store, async (tx) => {
      const { shop, setup } = await this.owner(tx, id, uid);
      if (shop.owner_id !== setup.telegram_user_id || shop.owner_bot_id !== setup.bot_id)
        throw new HttpError(
          409,
          'OWNER_UNVERIFIED',
          'Confirme sua conta no Telegram antes desta ação.',
        );
    });
    if (value.command.startsWith('admin:review-reject:') && !value.reason)
      throw new HttpError(400, 'REASON_REQUIRED', 'Informe o motivo da recusa.');
    return this.bots.portalCommand(id, uid, value.command, value.requestId, value.reason);
  }
  private async mediaClient(id: string, uid: string) {
    return botTransaction(this.store, async (tx) => {
      const { shop, setup } = await this.owner(tx, id, uid);
      if (
        !shop.owner_id ||
        shop.owner_id !== setup.telegram_user_id ||
        shop.owner_bot_id !== setup.bot_id
      )
        throw new HttpError(
          409,
          'OWNER_UNVERIFIED',
          'Confirme sua conta no Telegram para enviar imagens.',
        );
      const secret = await tx.get('merchant_bot_secrets/' + id);
      if (!secret) throw new HttpError(503, 'BOT_NOT_READY', 'Bot não configurado.');
      return {
        client: new TelegramClient(this.vault.open(secret.ciphertext, id + ':' + setup.bot_id)),
        ownerId: shop.owner_id,
      };
    });
  }
  async upload(id: string, uid: string, input: unknown) {
    const value = z
        .object({ data: z.string().max(4200000) })
        .strict()
        .parse(input),
      match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(value.data);
    if (!match)
      throw new HttpError(400, 'IMAGE_INVALID', 'Envie uma imagem JPG ou PNG de até 3 MB.');
    const bytes = Buffer.from(match[2], 'base64'),
      png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || (match[1] === 'png' ? !png : !jpg))
      throw new HttpError(400, 'IMAGE_INVALID', 'Imagem inválida ou maior que 3 MB.');
    const { client, ownerId } = await this.mediaClient(id, uid);
    const fileId = await client.uploadPhoto(ownerId, bytes, 'image/' + match[1]);
    await botTransaction(this.store, async (tx) => {
      await this.owner(tx, id, uid);
      tx.set(botPath(id, 'assets', fileId), { file_id: fileId, created_at: new Date() });
      this.audit(tx, id, uid, 'store.image_uploaded_web');
    });
    return { fileId };
  }
  async image(id: string, uid: string, fileId: string) {
    await botTransaction(this.store, async (tx) => {
      const { shop } = await this.owner(tx, id, uid),
        uploaded = await tx.get(botPath(id, 'assets', fileId));
      if (
        !uploaded &&
        shop.banner !== fileId &&
        !shop.products.some((p) => p.banner === fileId || p.pix_qr === fileId)
      )
        throw new HttpError(404, 'IMAGE_NOT_FOUND', 'Imagem não encontrada.');
    });
    const { client } = await this.mediaClient(id, uid);
    return client.file(fileId);
  }
  async receipt(id: string, uid: string, orderId: string) {
    const fileId = await botTransaction(this.store, async (tx) => {
      await this.owner(tx, id, uid);
      const order = await tx.get(botPath(id, 'orders', orderId));
      if (!order?.receipt_ciphertext)
        throw new HttpError(404, 'RECEIPT_NOT_FOUND', 'Comprovante não encontrado.');
      const proof = JSON.parse(
        this.vault.open(
          order.receipt_ciphertext,
          `${id}:receipt:${order.id}:${order.receipt_revision}`,
        ),
      );
      this.audit(tx, id, uid, 'store.receipt_viewed_web');
      return proof.fileId as string;
    });
    const { client } = await this.mediaClient(id, uid);
    return client.file(fileId);
  }
}
