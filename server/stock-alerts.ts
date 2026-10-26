import { randomUUID } from 'node:crypto';
import type { DocumentStore } from './document-store.js';
import type { RuntimeAccess, Shop } from './bot-types.js';
import { botPath, botRoot, botTransaction } from './bot-data.js';
import type { SecretVault } from './secret-vault.js';

// A bounded scan advances even when an earlier product is still unavailable.
export async function queueStockAlerts(
  store: DocumentStore,
  vault: SecretVault,
  auth: RuntimeAccess,
  now: Date,
) {
  const runtime = await store.get('bot_runtimes/' + auth.accountId);
  if (runtime?.generation !== auth.generation) return;
  const rows = await store.list(botRoot(auth.accountId) + '/stock_watchers', {
    limit: 40,
    afterId: runtime.stock_watch_cursor ?? '',
    equals: ['active', true],
  });
  await botTransaction(store, async (tx) => {
    const [current, rawShop, account, setup] = await Promise.all([
      tx.get('bot_runtimes/' + auth.accountId),
      tx.get(botRoot(auth.accountId)),
      tx.get('merchant_accounts/' + auth.accountId),
      tx.get('merchant_bot_setup/' + auth.accountId),
    ]);
    if (
      !current ||
      current.generation !== auth.generation ||
      !rawShop ||
      account?.access_status !== 'approved' ||
      setup?.activation_status !== 'active' ||
      account.paid_through <= now
    )
      return;
    const shop = rawShop as Shop;
    for (const row of rows) {
      const watchPath = botPath(auth.accountId, 'stock_watchers', row.id),
        watch = await tx.get(watchPath);
      if (
        !watch?.active ||
        watch.cancelled ||
        !shop.products.some((p) => p.id === watch.product_id && p.enabled && p.stock > 0)
      )
        continue;
      const product = shop.products.find((p) => p.id === watch.product_id)!;
      const eid = 'stock_' + randomUUID().replaceAll('-', '');
      const payload = {
        chat_id: watch.user_id,
        text: `${product.title} voltou ao estoque de ${shop.title}. A disponibilidade pode mudar até a compra.`,
        reply_markup: {
          inline_keyboard: [[{ text: 'Ver produto', callback_data: 'p:' + product.id }]],
        },
      };
      tx.set(botPath(auth.accountId, 'effects', eid), {
        id: eid,
        method: 'sendMessage',
        status: 'pending',
        stock_watch_id: watch.id,
        stock_watch_nonce: watch.nonce,
        created_at: now,
        payload_ciphertext: vault.seal(JSON.stringify(payload), `${auth.accountId}:effect:${eid}`),
      });
      tx.set(watchPath, { ...watch, active: false, notified_at: now });
    }
    tx.set('bot_runtimes/' + auth.accountId, {
      ...current,
      stock_watch_cursor: rows.length === 40 ? rows.at(-1)!.id : '',
    });
  });
}
