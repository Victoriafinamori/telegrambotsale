import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  HttpError,
  type Connection,
  type Database,
  type Identity,
  type MerchantAccount,
  type AdminMerchantAccount,
  type Channel,
} from './types.js';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Registration {
  name: string;
  email: string;
  storeName: string;
  channel: Channel;
  reference: string;
  priceCents: number;
}
export class Accounts {
  constructor(
    readonly db: Database,
    readonly inviteMs = 7 * 86400000,
  ) {}
  async audit(db: Connection, actor: string, action: string, accountId: string | null) {
    await db.query(
      'INSERT INTO platform_audit(id,actor_uid,action,account_id) VALUES($1,$2,$3,$4)',
      [randomUUID(), actor, action, accountId],
    );
  }
  async isAdmin(uid: string) {
    return (
      (await this.db.query('SELECT firebase_uid FROM platform_admins WHERE firebase_uid=$1', [uid]))
        .rows.length === 1
    );
  }
  async own(uid: string): Promise<MerchantAccount | null> {
    return (
      (
        await this.db.query<MerchantAccount>(
          'SELECT * FROM merchant_accounts WHERE firebase_uid=$1',
          [uid],
        )
      ).rows[0] || null
    );
  }
  async list(offset: number, queue: 'all' | 'activation' = 'all') {
    return (
      await this.db.query<AdminMerchantAccount>(
        `SELECT a.*,s.bot_username,s.activation_status AS bot_activation_status,s.submitted_at AS bot_submitted_at
         FROM merchant_accounts a LEFT JOIN merchant_bot_setup s ON s.account_id=a.id
         WHERE ($2='all' OR (s.submitted_at IS NOT NULL AND s.activation_status IN ('pending','configuring') AND a.access_status='approved'))
         ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET $1`,
        [offset, queue],
      )
    ).rows;
  }
  async history() {
    return (
      await this.db.query(
        'SELECT id,actor_uid,action,account_id,subject_uid,created_at FROM platform_audit ORDER BY created_at DESC,id LIMIT 50',
      )
    ).rows;
  }
  async register(v: Registration, actor: string) {
    return this.db.transaction(async (db) => {
      try {
        const account = (
          await db.query<MerchantAccount>(
            'INSERT INTO merchant_accounts(id,name,email,store_name,channel,reference,price_cents) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [randomUUID(), v.name, v.email, v.storeName, v.channel, v.reference, v.priceCents],
          )
        ).rows[0];
        await this.audit(db, actor, 'account.created', account.id);
        return account;
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new HttpError(409, 'EMAIL_EXISTS', 'Já existe uma contratação com esse e-mail.');
        throw e;
      }
    });
  }
  async locked(db: Connection, id: string) {
    const account = (
      await db.query<MerchantAccount>('SELECT * FROM merchant_accounts WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0];
    if (!account) throw new HttpError(404, 'NOT_FOUND', 'Loja não encontrada.');
    return account;
  }
  async confirm(id: string, actor: string) {
    return this.db.transaction(async (db) => {
      const a = await this.locked(db, id);
      if (a.purchase_confirmed_at) return a;
      const updated = (
        await db.query<MerchantAccount>(
          'UPDATE merchant_accounts SET purchase_confirmed_at=now() WHERE id=$1 RETURNING *',
          [id],
        )
      ).rows[0];
      await this.audit(db, actor, 'purchase.confirmed', id);
      return updated;
    });
  }
  async invite(id: string, actor: string) {
    return this.db.transaction(async (db) => {
      const a = await this.locked(db, id);
      if (!a.purchase_confirmed_at || a.firebase_uid || a.access_status === 'suspended')
        throw new HttpError(
          409,
          'INVITE_NOT_ALLOWED',
          'Confirme a contratação antes de gerar o convite. A loja não pode estar vinculada a outra conta ou suspensa.',
        );
      const token = randomBytes(32).toString('base64url'),
        expires = new Date(Date.now() + this.inviteMs);
      await db.query(
        'UPDATE merchant_invitations SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
        [id],
      );
      await db.query(
        'INSERT INTO merchant_invitations(id,account_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
        [randomUUID(), id, tokenHash(token), expires],
      );
      await this.audit(db, actor, 'invitation.created', id);
      return { token, expiresAt: expires };
    });
  }
  async inspect(token: string) {
    const a = (
      await this.db.query<{ store_name: string; email: string; expires_at: Date }>(
        `SELECT a.store_name,a.email,i.expires_at FROM merchant_invitations i JOIN merchant_accounts a ON a.id=i.account_id WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND a.firebase_uid IS NULL AND a.access_status<>'suspended'`,
        [tokenHash(token)],
      )
    ).rows[0];
    if (!a)
      throw new HttpError(
        410,
        'INVITE_UNAVAILABLE',
        'Convite vencido, utilizado ou indisponível. Solicite um novo à Blackout Create.',
      );
    const [local, domain] = a.email.split('@');
    return {
      storeName: a.store_name,
      emailHint: local.slice(0, 1) + '***@' + domain,
      expiresAt: a.expires_at,
    };
  }
  async accept(token: string, identity: Identity) {
    if (!identity.emailVerified)
      throw new HttpError(
        403,
        'EMAIL_UNVERIFIED',
        'Confirme seu e-mail antes de aceitar o convite.',
      );
    return this.db.transaction(async (db) => {
      const candidate = (
        await db.query<{ account_id: string }>(
          'SELECT account_id FROM merchant_invitations WHERE token_hash=$1',
          [tokenHash(token)],
        )
      ).rows[0];
      if (!candidate)
        throw new HttpError(
          410,
          'INVITE_UNAVAILABLE',
          'Convite indisponível. Solicite outro à Blackout Create.',
        );
      const a = await this.locked(db, candidate.account_id);
      const invitation = (
        await db.query<{ id: string }>(
          'SELECT id FROM merchant_invitations WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',
          [tokenHash(token)],
        )
      ).rows[0];
      if (
        !invitation ||
        a.firebase_uid ||
        !a.purchase_confirmed_at ||
        a.access_status === 'suspended'
      )
        throw new HttpError(
          410,
          'INVITE_UNAVAILABLE',
          'Convite vencido, utilizado ou indisponível.',
        );
      if (a.email !== identity.email.trim().toLowerCase())
        throw new HttpError(
          403,
          'INVITE_EMAIL_MISMATCH',
          'Entre com o mesmo e-mail que foi cadastrado na contratação.',
        );
      if (
        (await db.query('SELECT id FROM merchant_accounts WHERE firebase_uid=$1', [identity.uid]))
          .rows.length
      )
        throw new HttpError(409, 'ALREADY_BOUND', 'Essa conta já está vinculada a uma loja.');
      const updated = (
        await db.query<MerchantAccount>(
          'UPDATE merchant_accounts SET firebase_uid=$1 WHERE id=$2 RETURNING *',
          [identity.uid, a.id],
        )
      ).rows[0];
      await db.query('UPDATE merchant_invitations SET used_at=now() WHERE id=$1', [invitation.id]);
      await this.audit(db, identity.uid, 'invitation.accepted', a.id);
      return updated;
    });
  }
  async approve(id: string, actor: string) {
    return this.db.transaction(async (db) => {
      const a = await this.locked(db, id);
      if (!a.purchase_confirmed_at || !a.firebase_uid)
        throw new HttpError(
          409,
          'APPROVAL_NOT_ALLOWED',
          'O lojista precisa aceitar o convite e a contratação deve estar confirmada.',
        );
      if (a.access_status === 'approved') return a;
      const updated = (
        await db.query<MerchantAccount>(
          "UPDATE merchant_accounts SET access_status='approved',approved_at=COALESCE(approved_at,now()),suspension_reason=NULL WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.audit(db, actor, 'access.approved', id);
      return updated;
    });
  }
  async suspend(id: string, reason: string, actor: string) {
    return this.db.transaction(async (db) => {
      await this.locked(db, id);
      const updated = (
        await db.query<MerchantAccount>(
          "UPDATE merchant_accounts SET access_status='suspended',suspension_reason=$1 WHERE id=$2 RETURNING *",
          [reason, id],
        )
      ).rows[0];
      await db.query(
        'UPDATE merchant_invitations SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
        [id],
      );
      await this.audit(db, actor, 'access.suspended', id);
      return updated;
    });
  }
  async restore(id: string, actor: string) {
    return this.db.transaction(async (db) => {
      const a = await this.locked(db, id);
      if (a.access_status !== 'suspended') return a;
      const status = a.firebase_uid && a.approved_at ? 'approved' : 'pending';
      const updated = (
        await db.query<MerchantAccount>(
          'UPDATE merchant_accounts SET access_status=$1,suspension_reason=NULL WHERE id=$2 RETURNING *',
          [status, id],
        )
      ).rows[0];
      await this.audit(db, actor, 'access.restored', id);
      return updated;
    });
  }
  async consumeRate(bucket: string, limit: number, windowMs: number) {
    const result = (
      await this.db.query<{ hits: number }>(
        `INSERT INTO api_rate_limits(bucket,hits,expires_at) VALUES($1,1,$2) ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN api_rate_limits.expires_at<=now() THEN 1 ELSE api_rate_limits.hits+1 END,expires_at=CASE WHEN api_rate_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE api_rate_limits.expires_at END RETURNING hits`,
        [bucket, new Date(Date.now() + windowMs)],
      )
    ).rows[0];
    if (result.hits > limit)
      throw new HttpError(
        429,
        'RATE_LIMIT',
        'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
      );
  }
}
