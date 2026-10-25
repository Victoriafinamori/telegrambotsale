import type { TelegramMethod } from './bot-types.js';

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
  ) {
    super('Telegram request failed');
    this.name = 'TelegramError';
  }
}
// Never include Telegram request URLs, tokens or API bodies in exceptions or logs.
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!/^\d{5,16}:[A-Za-z0-9_-]{30,80}$/.test(token)) throw Error('Invalid bot token');
  }
  async call<T = unknown>(
    method: TelegramMethod | 'getMe' | 'getUpdates' | 'getWebhookInfo',
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 35000 : 20000),
      });
    } catch {
      throw new TelegramError(0);
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      parameters?: { retry_after?: number };
    } | null;
    if (!response.ok || !data?.ok)
      throw new TelegramError(
        Number(data?.error_code ?? response.status),
        Math.min(86400, Math.max(0, Number(data?.parameters?.retry_after ?? 0))),
      );
    return data.result as T;
  }
}
