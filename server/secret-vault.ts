import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './types.js';
export class SecretVault {
  private readonly key?: Buffer;
  constructor(key?: string) {
    this.key = key ? Buffer.from(key, 'base64url') : undefined;
    if (this.key && this.key.length !== 32) throw new Error('Invalid encryption key');
  }
  requireKey() {
    if (!this.key)
      throw new HttpError(
        503,
        'BOT_SETUP_UNAVAILABLE',
        'O envio protegido ainda não foi configurado pela Blackout Create. Não envie o token por mensagem.',
      );
    return this.key;
  }
  seal(secret: string, context: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }
  open(payload: string, context: string) {
    const key = this.requireKey();
    try {
      const parts = payload.split('.'),
        [version, iv, tag, encrypted] = parts;
      if (
        parts.length !== 4 ||
        version !== 'v1' ||
        [iv, tag, encrypted].some(
          (v) =>
            !v ||
            !/^[A-Za-z0-9_-]+$/.test(v) ||
            Buffer.from(v, 'base64url').toString('base64url') !== v,
        ) ||
        Buffer.from(iv, 'base64url').length !== 12 ||
        Buffer.from(tag, 'base64url').length !== 16
      )
        throw Error();
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        cipher.update(Buffer.from(encrypted, 'base64url')),
        cipher.final(),
      ]).toString('utf8');
    } catch {
      throw new HttpError(
        503,
        'BOT_SECRET_UNAVAILABLE',
        'Não foi possível abrir o segredo. Verifique a chave protegida do servidor.',
      );
    }
  }
}
