import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tokenHash } from './accounts.js';
import type { DocumentStore } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { HttpError, type Identity } from './types.js';
import { adminPath } from './firestore-platform.js';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function totp(secret: Buffer, counter: number) {
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(data).digest(),
    offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
export class AdminMfa {
  private vault: SecretVault;
  constructor(
    private store: DocumentStore,
    key: string,
  ) {
    this.vault = new SecretVault(key);
  }
  private path(uid: string) {
    return 'admin_mfa/' + tokenHash(uid);
  }
  async status(uid: string) {
    const value = await this.store.get(this.path(uid));
    return { enabled: Boolean(value?.enabled_at) };
  }
  async enroll(user: Identity) {
    if (Math.abs(Date.now() / 1000 - user.authTime) > 300)
      throw new HttpError(
        401,
        'RECENT_LOGIN_REQUIRED',
        'Entre novamente para configurar o autenticador.',
      );
    const secret = randomBytes(20),
      encrypted = this.vault.seal(secret.toString('base64url'), 'admin-mfa:' + user.uid);
    await this.store.transaction(async (tx) => {
      const existing = await tx.get(this.path(user.uid)),
        admin = await tx.get(adminPath(user.uid));
      if (!admin) throw new HttpError(403, 'ADMIN_REQUIRED', 'Ação exclusiva da Blackout Create.');
      if (existing?.enabled_at)
        throw new HttpError(
          409,
          'MFA_ALREADY_ENABLED',
          'O autenticador já foi configurado. Para recuperar o acesso, use o procedimento privado do servidor.',
        );
      tx.set(this.path(user.uid), {
        secret_ciphertext: encrypted,
        enabled_at: null,
        expires_at: new Date(Date.now() + 600000),
        last_counter: -1,
      });
    });
    return {
      secret: base32(secret),
      issuer: 'Blackout Create',
      account: user.email,
      expiresInSeconds: 600,
    };
  }
  async verify(user: Identity, binding: string, code: string) {
    if (!/^\d{6}$/.test(code))
      throw new HttpError(403, 'MFA_CODE_INVALID', 'Digite o código de 6 dígitos do autenticador.');
    const proof = randomBytes(32).toString('base64url'),
      now = new Date(),
      expires = new Date(now.getTime() + 15 * 60000);
    await this.store.transaction(async (tx) => {
      const saved = await tx.get(this.path(user.uid)),
        admin = await tx.get(adminPath(user.uid));
      if (!admin) throw new HttpError(403, 'ADMIN_REQUIRED', 'Ação exclusiva da Blackout Create.');
      if (!saved || (!saved.enabled_at && saved.expires_at <= now))
        throw new HttpError(
          409,
          'MFA_ENROLLMENT_REQUIRED',
          'Configure o autenticador antes de continuar.',
        );
      const secret = Buffer.from(
          this.vault.open(saved.secret_ciphertext, 'admin-mfa:' + user.uid),
          'base64url',
        ),
        current = Math.floor(now.getTime() / 30000);
      const matched = [current, current - 1, current + 1].find(
        (counter) =>
          counter >= 0 &&
          counter > saved.last_counter &&
          timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code)),
      );
      if (matched === undefined)
        throw new HttpError(
          403,
          'MFA_CODE_INVALID',
          'Código inválido ou já utilizado. Confira o autenticador e tente o próximo código.',
        );
      tx.set(this.path(user.uid), {
        ...saved,
        enabled_at: saved.enabled_at || now,
        last_counter: matched,
      });
      tx.set('admin_mfa_proofs/' + tokenHash(proof), {
        uid: user.uid,
        binding: tokenHash(binding),
        expires_at: expires,
      });
      const id = randomBytes(16).toString('hex');
      tx.set('platform_audit/' + id, {
        id,
        actor_uid: user.uid,
        action: saved.enabled_at ? 'admin.mfa_verified' : 'admin.mfa_enabled',
        account_id: null,
        subject_uid: user.uid,
        created_at: now,
      });
    });
    return { proof, expiresAt: expires };
  }
  async verified(uid: string, binding: string, proof: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
    const [saved, mfa] = await Promise.all([
      this.store.get('admin_mfa_proofs/' + tokenHash(proof)),
      this.store.get(this.path(uid)),
    ]);
    return Boolean(
      mfa?.enabled_at &&
        saved &&
        saved.uid === uid &&
        saved.binding === tokenHash(binding) &&
        saved.expires_at > new Date(),
    );
  }
}
