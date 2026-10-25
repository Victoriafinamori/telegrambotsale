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
    method: TelegramMethod | 'getMe' | 'getUpdates' | 'getWebhookInfo' | 'getFile',
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
  async uploadPhoto(chatId: string, bytes: Uint8Array, mime: string) {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', 'Imagem enviada pelo painel da sua loja.');
    form.set(
      'photo',
      new Blob([new Uint8Array(bytes)], { type: mime }),
      'imagem.' + (mime === 'image/png' ? 'png' : 'jpg'),
    );
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new TelegramError(0);
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { photo?: { file_id: string }[] };
      error_code?: number;
    } | null;
    const fileId = data?.result?.photo?.at(-1)?.file_id;
    if (!response.ok || !data?.ok || !fileId)
      throw new TelegramError(data?.error_code ?? response.status);
    return fileId;
  }
  async file(fileId: string) {
    const value = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (
      !value.file_path ||
      !/^[A-Za-z0-9_./-]+$/.test(value.file_path) ||
      value.file_path.includes('..')
    )
      throw new TelegramError(0);
    let response: Response;
    try {
      response = await this.request(
        `https://api.telegram.org/file/bot${this.token}/${value.file_path}`,
        { signal: AbortSignal.timeout(20000) },
      );
    } catch {
      throw new TelegramError(0);
    }
    if (!response.ok) throw new TelegramError(response.status);
    if (Number(response.headers.get('content-length') ?? 0) > 8 * 1024 * 1024)
      throw new TelegramError(413);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) throw new TelegramError(413);
    return { bytes, type: response.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
