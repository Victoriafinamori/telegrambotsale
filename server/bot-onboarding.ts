import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Accounts } from './accounts.js';
import { HttpError, type Connection } from './types.js';

export const botCredentials = z
  .object({
    botToken: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{30,80}$/),
    telegramUserId: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{0,15}$/)
      .refine((v) => /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)),
  })
  .strict();
export type BotInfo = { id: string; username: string };
export type BotVerifier = (token: string) => Promise<BotInfo>;
export interface BotSetup {
  bot_id: string;
  bot_username: string;
  telegram_user_id: string;
  submitted_at: Date | null;
  updated_at: Date;
  activation_status: 'pending' | 'configuring' | 'changes_requested' | 'active';
  review_note: string | null;
  reviewed_at: Date | null;
  activated_at: Date | null;
  deployment_reference: string | null;
  revision: number;
}
const publicFields =
  'bot_id,bot_username,telegram_user_id,submitted_at,updated_at,activation_status,review_note,reviewed_at,activated_at,deployment_reference,revision';

export const verifyTelegramBot: BotVerifier = async (token) => {
  // Telegram requires the credential in this URL. Never propagate fetch errors or its URL.
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(
      503,
      'TELEGRAM_UNAVAILABLE',
      'Não foi possível consultar o Telegram. Tente novamente.',
    );
  }
  if ([401, 404].includes(response.status))
    throw new HttpError(
      400,
      'BOT_TOKEN_INVALID',
      'Token não reconhecido. Copie o token completo no BotFather.',
    );
  try {
    if (!response.ok) throw Error();
    const value = await response.json();
    const bot = z
      .object({
        ok: z.literal(true),
        result: z.object({
          id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          is_bot: z.literal(true),
          username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
        }),
      })
      .parse(value).result;
    if (String(bot.id) !== token.split(':')[0]) throw Error();
    return { id: String(bot.id), username: bot.username };
  } catch {
    throw new HttpError(
      503,
      'TELEGRAM_UNAVAILABLE',
      'O Telegram não confirmou os dados do bot. Tente novamente.',
    );
  }
};

// Isolated demo only: accepts synthetic fixtures and never contacts Telegram.
export const verifyDemoBot: BotVerifier = async (token) => {
  if (!/^[1-9][0-9]{4,15}:A{35}$/.test(token))
    throw new HttpError(
      400,
      'DEMO_TOKEN_ONLY',
      'Neste ambiente, use apenas o token fictício exibido na tela.',
    );
  return { id: token.split(':')[0], username: 'BlackoutDemoBot_' + token.split(':')[0] };
};

export class BotOnboarding {
  private readonly key?: Buffer;
  constructor(
    private readonly accounts: Accounts,
    key?: string,
    private readonly verify: BotVerifier = verifyTelegramBot,
  ) {
    this.key = key ? Buffer.from(key, 'base64url') : undefined;
    if (this.key && this.key.length !== 32) throw new Error('Invalid bot encryption key');
  }
  private requireKey() {
    if (!this.key)
      throw new HttpError(
        503,
        'BOT_SETUP_UNAVAILABLE',
        'O envio protegido ainda não foi configurado pela Blackout Create. Não envie o token por mensagem.',
      );
    return this.key;
  }
  private async owner(uid: string) {
    const a = await this.accounts.own(uid);
    if (!a || a.access_status !== 'approved')
      throw new HttpError(
        403,
        'STORE_NOT_APPROVED',
        'Aguarde a liberação da sua loja para enviar os dados.',
      );
    return a;
  }
  private editable(a: { access_status: string; billing_started_at: Date | null }) {
    if (a.access_status !== 'approved' || a.billing_started_at)
      throw new HttpError(
        409,
        'BOT_SETUP_LOCKED',
        'A configuração não pode ser alterada agora. Fale com a Blackout Create.',
      );
  }
  async read(accountId: string, db: Connection = this.accounts.db): Promise<BotSetup | null> {
    return (
      (
        await db.query<BotSetup>(
          `SELECT ${publicFields} FROM merchant_bot_setup WHERE account_id=$1`,
          [accountId],
        )
      ).rows[0] || null
    );
  }
  async own(uid: string) {
    const a = await this.owner(uid);
    return this.read(a.id);
  }
  async save(uid: string, input: z.infer<typeof botCredentials>) {
    const key = this.requireKey(),
      a = await this.owner(uid);
    this.editable(a);
    const bot = await this.verify(input.botToken);
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    // Binding to both tenant and bot prevents moving ciphertext between rows.
    cipher.setAAD(Buffer.from(a.id + ':' + bot.id));
    const data = Buffer.concat([cipher.update(input.botToken, 'utf8'), cipher.final()]);
    const encrypted = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join('.');
    try {
      return await this.accounts.db.transaction(async (db) => {
        this.editable(await this.accounts.locked(db, a.id));
        const existing = await this.read(a.id, db);
        if (existing?.activation_status === 'configuring')
          throw new HttpError(
            409,
            'BOT_CONFIGURING',
            'A equipe já está configurando seu bot. Peça a liberação para corrigir os dados.',
          );
        await db.query(
          `INSERT INTO merchant_bot_setup(account_id,bot_id,bot_username,telegram_user_id,token_ciphertext)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO UPDATE SET bot_id=EXCLUDED.bot_id,bot_username=EXCLUDED.bot_username,telegram_user_id=EXCLUDED.telegram_user_id,token_ciphertext=EXCLUDED.token_ciphertext,submitted_at=NULL,activation_status='pending',review_note=NULL,reviewed_at=NULL,revision=merchant_bot_setup.revision+1,updated_at=now()`,
          [a.id, bot.id, bot.username, input.telegramUserId, encrypted],
        );
        await this.accounts.audit(db, uid, 'bot_setup.saved', a.id);
        return this.read(a.id, db);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new HttpError(
          409,
          'BOT_UNAVAILABLE',
          'Este bot não está disponível para vinculação. Fale com a Blackout Create.',
        );
      throw e;
    }
  }
  async submit(uid: string) {
    const a = await this.owner(uid);
    return this.accounts.db.transaction(async (db) => {
      this.editable(await this.accounts.locked(db, a.id));
      const setup = await this.read(a.id, db);
      if (!setup)
        throw new HttpError(
          409,
          'BOT_SETUP_MISSING',
          'Informe e valide os dados do bot antes de continuar.',
        );
      if (!setup.submitted_at) {
        await db.query(
          'UPDATE merchant_bot_setup SET submitted_at=now(),revision=revision+1,updated_at=now() WHERE account_id=$1',
          [a.id],
        );
        await this.accounts.audit(db, uid, 'bot_setup.submitted', a.id);
      }
      return this.read(a.id, db);
    });
  }
  private current(setup: BotSetup | null, revision: number) {
    if (!setup?.submitted_at)
      throw new HttpError(
        409,
        'BOT_SETUP_MISSING',
        'O lojista precisa enviar os dados antes desta ação.',
      );
    if (setup.revision !== revision)
      throw new HttpError(
        409,
        'BOT_SETUP_CHANGED',
        'Os dados foram atualizados. Atualize a página e confira novamente.',
      );
    return setup;
  }
  async review(
    accountId: string,
    actor: string,
    input: { action: 'configure' | 'request_changes'; revision: number; note: string },
  ) {
    return this.accounts.db.transaction(async (db) => {
      this.editable(await this.accounts.locked(db, accountId));
      const setup = this.current(await this.read(accountId, db), input.revision);
      if (setup.activation_status === 'active')
        throw new HttpError(409, 'BOT_SETUP_LOCKED', 'A ativação já foi confirmada.');
      if (input.action === 'configure' && setup.activation_status === 'changes_requested')
        throw new HttpError(
          409,
          'CORRECTION_PENDING',
          'Aguarde o lojista corrigir e reenviar os dados.',
        );
      const status = input.action === 'configure' ? 'configuring' : 'changes_requested';
      if (setup.activation_status === status && setup.review_note === (input.note || null))
        return setup;
      await db.query(
        'UPDATE merchant_bot_setup SET activation_status=$1,review_note=$2,reviewed_at=now(),revision=revision+1,updated_at=now() WHERE account_id=$3',
        [status, input.note || null, accountId],
      );
      await this.accounts.audit(db, actor, 'bot_setup.' + status, accountId);
      return this.read(accountId, db);
    });
  }
  async activate(
    accountId: string,
    actor: string,
    input: { revision: number; deploymentReference: string },
  ) {
    this.requireKey();
    return this.accounts.db
      .transaction(async (db) => {
        const account = await this.accounts.locked(db, accountId),
          setup = await this.read(accountId, db);
        if (
          account.access_status !== 'approved' ||
          !account.purchase_confirmed_at ||
          !account.firebase_uid
        )
          throw new HttpError(
            409,
            'ACTIVATION_NOT_ALLOWED',
            'Confirme a contratação e libere o acesso do lojista antes da ativação.',
          );
        // A repeated confirmation cannot restart or extend the paid period.
        if (
          setup?.activation_status === 'active' &&
          setup.deployment_reference === input.deploymentReference
        )
          return { setup, account };
        this.current(setup, input.revision);
        if (account.billing_started_at || setup?.activation_status !== 'configuring')
          throw new HttpError(
            409,
            'ACTIVATION_NOT_ALLOWED',
            'Marque o bot em configuração e confira a instalação antes de confirmar.',
          );
        const activated = (
          await db.query(
            "UPDATE merchant_accounts SET billing_started_at=now(),paid_through=((now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month') AT TIME ZONE 'America/Sao_Paulo' WHERE id=$1 RETURNING *",
            [accountId],
          )
        ).rows[0];
        await db.query(
          "UPDATE merchant_bot_setup SET activation_status='active',activated_at=now(),activated_by=$1,deployment_reference=$2,review_note=NULL,revision=revision+1,updated_at=now() WHERE account_id=$3",
          [actor, input.deploymentReference, accountId],
        );
        await this.accounts.audit(db, actor, 'bot_activation.confirmed_manually', accountId);
        return { setup: await this.read(accountId, db), account: activated };
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505')
          throw new HttpError(
            409,
            'DEPLOYMENT_ALREADY_LINKED',
            'Este aplicativo da Square Cloud já está vinculado a outro cliente.',
          );
        throw error;
      });
  }
  async reveal(accountId: string, actor: string) {
    const key = this.requireKey();
    return this.accounts.db.transaction(async (db) => {
      const a = await this.accounts.locked(db, accountId);
      if (a.access_status !== 'approved')
        throw new HttpError(409, 'BOT_SETUP_LOCKED', 'A loja precisa estar liberada.');
      const row = (
        await db.query<{ token_ciphertext: string; bot_id: string; submitted_at: Date | null }>(
          'SELECT token_ciphertext,bot_id,submitted_at FROM merchant_bot_setup WHERE account_id=$1',
          [accountId],
        )
      ).rows[0];
      if (!row?.submitted_at)
        throw new HttpError(
          409,
          'BOT_SETUP_MISSING',
          'O lojista ainda não enviou os dados para ativação.',
        );
      let token: string;
      try {
        const parts = row.token_ciphertext.split('.');
        const [version, iv, tag, encrypted] = parts;
        if (
          version !== 'v1' ||
          parts.length !== 4 ||
          [iv, tag, encrypted].some(
            (v) =>
              !/^[A-Za-z0-9_-]+$/.test(v) ||
              Buffer.from(v, 'base64url').toString('base64url') !== v,
          ) ||
          Buffer.from(iv, 'base64url').length !== 12 ||
          Buffer.from(tag, 'base64url').length !== 16
        )
          throw Error();
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(accountId + ':' + row.bot_id));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        token = Buffer.concat([
          decipher.update(Buffer.from(encrypted, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new HttpError(
          503,
          'BOT_SECRET_UNAVAILABLE',
          'Não foi possível abrir o segredo. Verifique a chave protegida do servidor.',
        );
      }
      await this.accounts.audit(db, actor, 'bot_token.accessed', accountId);
      return token;
    });
  }
}
