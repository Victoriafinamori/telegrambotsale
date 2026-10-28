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
    timeoutMs?: number,
  ): Promise<T> {
    let response: Response;
    let body: BodyInit = JSON.stringify(payload);
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (
      method === 'sendPhoto' &&
      typeof payload.photo === 'string' &&
      payload.photo.startsWith('data:')
    ) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]{1,400000})$/.exec(payload.photo);
      if (!match) throw new TelegramError(400);
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new TelegramError(400);
      const form = new FormData();
      for (const [name, value] of Object.entries(payload))
        if (name !== 'photo' && value !== undefined)
          form.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      form.set('photo', new Blob([bytes], { type: 'image/png' }), 'pagamento-pix.png');
      body = form;
      headers = {};
    }
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs ?? (method === 'getUpdates' ? 35000 : 20000)),
      });
    } catch {
      throw new TelegramError(0);
    }
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (
      data?.error_code === 400 &&
      ['editMessageText', 'editMessageMedia'].includes(method) &&
      data.description?.startsWith('Bad Request: message is not modified')
    )
      return true as T;
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
