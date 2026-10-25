import 'dotenv/config';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramClient, TelegramError } from './telegram-client.js';
import type { BotEffect, TelegramUpdate } from './bot-types.js';

export class RuntimeApiError extends Error {
  constructor(readonly status: number) {
    super('Runtime API request failed');
  }
}
export class BotRuntimeApi {
  readonly origin: string;
  constructor(
    origin: string,
    private key: string,
    private request: typeof fetch = fetch,
    allowLocal = false,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(allowLocal && url.hostname === '127.0.0.1'))
    )
      throw Error('Use the exact HTTPS API origin');
    if (!/^botr_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(key)) throw Error('Invalid runtime key');
    this.origin = origin;
  }
  async call<T>(path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await this.request(this.origin + '/internal/bot' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + this.key,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new RuntimeApiError(0);
    }
    if (!r.ok) throw new RuntimeApiError(r.status);
    return r.json() as Promise<T>;
  }
}
export async function dispatchEffects(api: BotRuntimeApi, telegram: TelegramClient, ids: string[]) {
  for (const id of new Set(ids)) {
    const { effect } = await api.call<{ effect: (BotEffect & { lease: string }) | null }>(
      `/effects/${id}/claim`,
      {},
    );
    if (!effect) continue;
    let result: 'sent' | 'uncertain' = 'sent';
    try {
      await telegram.call(effect.method, effect.payload);
    } catch {
      result = 'uncertain';
    }
    // If this ack cannot reach the API, the persisted sending lease stays blocked.
    // Restart never blindly resends a delivery with an ambiguous result.
    await api.call(`/effects/${id}/ack`, { lease: effect.lease, result });
  }
}
export async function processTelegramUpdate(
  api: BotRuntimeApi,
  telegram: TelegramClient,
  update: TelegramUpdate,
) {
  // Telegram entities, thumbnail metadata and other unused fields can be large.
  // Forward only the fields consumed by the shop, never arbitrary raw metadata.
  const from = (user: { id: number; is_bot?: boolean } | undefined) =>
    user ? { id: user.id, is_bot: user.is_bot } : undefined;
  const payment = update.message?.successful_payment;
  const refund = update.message?.refunded_payment;
  const pre = update.pre_checkout_query,
    callback = update.callback_query,
    message = update.message;
  const normalized = {
    update_id: update.update_id,
    ...(message
      ? {
          message: {
            message_id: message.message_id,
            from: from(message.from),
            chat: { id: message.chat.id, type: message.chat.type },
            text: message.text,
            document: message.document ? { file_id: message.document.file_id } : undefined,
            photo: message.photo?.map((photo) => ({ file_id: photo.file_id })),
            successful_payment: payment
              ? {
                  currency: payment.currency,
                  total_amount: payment.total_amount,
                  invoice_payload: payment.invoice_payload,
                  telegram_payment_charge_id: payment.telegram_payment_charge_id,
                }
              : undefined,
            refunded_payment: refund
              ? {
                  currency: refund.currency,
                  total_amount: refund.total_amount,
                  invoice_payload: refund.invoice_payload,
                  telegram_payment_charge_id: refund.telegram_payment_charge_id,
                }
              : undefined,
          },
        }
      : {}),
    ...(callback
      ? {
          callback_query: {
            id: callback.id,
            from: from(callback.from),
            data: callback.data,
            message: callback.message
              ? { chat: { id: callback.message.chat.id, type: callback.message.chat.type } }
              : undefined,
          },
        }
      : {}),
    ...(pre
      ? {
          pre_checkout_query: {
            id: pre.id,
            from: from(pre.from),
            currency: pre.currency,
            total_amount: pre.total_amount,
            invoice_payload: pre.invoice_payload,
          },
        }
      : {}),
  };
  const result = await api.call<{ effectIds: string[] }>('/updates', normalized);
  await dispatchEffects(api, telegram, result.effectIds);
}

export async function runBot() {
  const api = new BotRuntimeApi(
    process.env.BOT_API_ORIGIN ?? '',
    process.env.BOT_RUNTIME_KEY ?? '',
  );
  const cfg = await api.call<{ botId: string; botToken: string; offset: number }>('/config');
  const telegram = new TelegramClient(cfg.botToken);
  cfg.botToken = '';
  const me = await telegram.call<{ id: number; is_bot: boolean }>('getMe');
  if (!me.is_bot || String(me.id) !== cfg.botId)
    throw Error('Bot identity does not match the registered shop');
  const webhook = await telegram.call<{ url: string }>('getWebhookInfo');
  if (webhook.url) throw Error('Bot already has a webhook; coordinate migration before starting');
  let running = true,
    offset = cfg.offset,
    lastHealthy = Date.now(),
    lastHeartbeat = 0;
  const port = Number(process.env.PORT ?? 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid HTTP health port');
  const health = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const ok = running && Date.now() - lastHealthy < 90000;
    res.statusCode = req.url === '/health' ? (ok ? 200 : 503) : 404;
    res.end(JSON.stringify(req.url === '/health' ? { ok } : { error: 'not_found' }));
  }).listen(port, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      running = false;
      health.close();
    });
  console.log('Blackout bot runtime started.');
  try {
    while (running) {
      try {
        if (Date.now() - lastHeartbeat > 45000) {
          await api.call('/heartbeat', {});
          const pending = await api.call<{ ids: string[] }>('/effects');
          await dispatchEffects(api, telegram, pending.ids);
          lastHeartbeat = Date.now();
        }
        const updates = await telegram.call<TelegramUpdate[]>('getUpdates', {
          offset,
          limit: 20,
          timeout: 25,
          allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        });
        for (const update of updates) {
          await processTelegramUpdate(api, telegram, update);
          offset = update.update_id + 1;
        }
        lastHealthy = Date.now();
      } catch (e) {
        if (
          (e instanceof RuntimeApiError && [401, 403].includes(e.status)) ||
          (e instanceof TelegramError && [401, 409].includes(e.code))
        )
          throw Error('Runtime authorization or bot ownership changed; operation stopped');
        console.error(
          JSON.stringify({
            event: 'bot_runtime.retry',
            category: e instanceof TelegramError ? 'telegram' : 'api',
          }),
        );
        await delay(5000);
      }
    }
  } finally {
    health.close();
  }
}
// Importing the runner for integration tests must never start a bot or open a port.
if (process.argv[1]?.replaceAll('\\', '/').match(/\/bot-runner\.(?:js|ts)$/)) {
  runBot().catch(() => {
    console.error(
      'Bot runtime could not continue. Check identity, private configuration, webhook and API health.',
    );
    process.exitCode = 1;
  });
}
