import { randomBytes, randomUUID } from 'node:crypto';
import { tokenHash, emailCorrection, type Registration } from './accounts.js';
import {
  HttpError,
  type Identity,
  type MerchantAccount,
  type AdminMerchantAccount,
} from './types.js';
import type { AccountService, OnboardingService } from './platform-contract.js';
import {
  type BotSetup,
  type BotVerifier,
  verifyTelegramBot,
  botCredentials,
} from './bot-onboarding.js';
import type { z } from 'zod';
import type { DocumentStore, DocumentTransaction, Doc } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { nextBillingMonth } from './billing-period.js';

const accountFields = [
  'id',
  'name',
  'email',
  'store_name',
  'channel',
  'reference',
  'price_cents',
  'billing_months',
  'firebase_uid',
  'purchase_confirmed_at',
  'access_status',
  'created_at',
  'approved_at',
  'suspension_reason',
  'billing_started_at',
  'paid_through',
];
const setupFields = [
  'bot_id',
  'bot_username',
  'telegram_user_id',
  'submitted_at',
  'updated_at',
  'activation_status',
  'review_note',
  'reviewed_at',
  'activated_at',
  'deployment_reference',
  'revision',
];
const pick = <T>(data: Doc, fields: string[]) =>
  Object.fromEntries(fields.map((key) => [key, data[key] ?? null])) as T;
const accountPath = (id: string) => 'merchant_accounts/' + id;
const setupPath = (id: string) => 'merchant_bot_setup/' + id;
const uidPath = (uid: string) => 'platform_uids/' + tokenHash(uid);
export const adminPath = (uid: string) => 'platform_admins/' + tokenHash(uid);
const inviteError = () =>
  new HttpError(
    410,
    'INVITE_UNAVAILABLE',
    'Convite vencido, utilizado ou indisponível. Solicite um novo à Blackout Create.',
  );

export class FirestorePlatform implements AccountService {
  private vault: SecretVault;
  readonly onboarding: OnboardingService;
  constructor(
    readonly store: DocumentStore,
    key?: string,
    private verify: BotVerifier = verifyTelegramBot,
    readonly inviteMs = 7 * 86400000,
  ) {
    this.vault = new SecretVault(key);
    this.onboarding = {
      read: (id) => this.readSetup(id),
      own: async (uid) => this.readSetup((await this.owner(uid)).id),
      save: (uid, input) => this.saveBot(uid, input),
      submit: (uid) => this.submitBot(uid),
      review: (id, actor, input) => this.reviewBot(id, actor, input),
      activate: (id, actor, input) => this.activateBot(id, actor, input),
      reveal: (id, actor) => this.revealBot(id, actor),
    };
  }
  private audit(
    tx: DocumentTransaction,
    actor: string,
    action: string,
    accountId: string | null,
    subjectUid: string | null = null,
  ) {
    const id = randomUUID();
    tx.set('platform_audit/' + id, {
      id,
      actor_uid: actor,
      action,
      account_id: accountId,
      subject_uid: subjectUid,
      created_at: new Date(),
    });
  }
  async grantAdmin(uid: string, revoke = false) {
    await this.store.transaction(async (tx) => {
      await tx.get(adminPath(uid));
      if (revoke) {
        tx.delete(adminPath(uid));
        tx.delete('admin_mfa/' + tokenHash(uid));
      } else tx.set(adminPath(uid), { firebase_uid: uid, created_at: new Date() });
      this.audit(tx, 'server-bootstrap', revoke ? 'admin.revoked' : 'admin.granted', null, uid);
    });
  }
  async isAdmin(uid: string) {
    return Boolean(await this.store.get(adminPath(uid)));
  }
  async own(uid: string): Promise<MerchantAccount | null> {
    const link = await this.store.get(uidPath(uid));
    if (!link) return null;
    const a = await this.store.get(accountPath(link.account_id));
    return a?.firebase_uid === uid ? pick<MerchantAccount>(a, accountFields) : null;
  }
  async list(offset: number, queue: 'all' | 'activation' = 'all'): Promise<AdminMerchantAccount[]> {
    const values = await this.store.list('merchant_accounts', {
      offset,
      limit: 50,
      orderBy: 'created_at',
      ...(queue === 'activation'
        ? { equals: ['activation_pending', true] as [string, unknown] }
        : {}),
    });
    return values.map((a) => ({
      ...pick<MerchantAccount>(a, accountFields),
      bot_username: a.bot_username ?? null,
      bot_activation_status: a.bot_activation_status ?? null,
      bot_submitted_at: a.bot_submitted_at ?? null,
    }));
  }
  async history(): Promise<Record<string, unknown>[]> {
    return this.store.list('platform_audit', { limit: 50, orderBy: 'created_at' });
  }
  async register(v: Registration, actor: string) {
    const id = randomUUID(),
      emailPath = 'platform_emails/' + tokenHash(v.email);
    return this.store.transaction(async (tx) => {
      if (await tx.get(emailPath))
        throw new HttpError(409, 'EMAIL_EXISTS', 'Já existe uma contratação com esse e-mail.');
      const a: MerchantAccount = {
        id,
        name: v.name,
        email: v.email,
        store_name: v.storeName,
        channel: v.channel,
        reference: v.reference,
        price_cents: v.priceCents,
        firebase_uid: null,
        purchase_confirmed_at: null,
        access_status: 'pending',
        created_at: new Date(),
        approved_at: null,
        suspension_reason: null,
        billing_started_at: null,
        paid_through: null,
      };
      tx.set(accountPath(id), { ...a, invitation_generation: 0, activation_pending: false });
      tx.set(emailPath, { account_id: id });
      this.audit(tx, actor, 'account.created', id);
      return a;
    });
  }
  private async account(tx: DocumentTransaction, id: string) {
    const a = await tx.get(accountPath(id));
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Loja não encontrada.');
    return a;
  }
  private async mutate(id: string, actor: string, action: string, update: (a: Doc) => Doc) {
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, id),
        next = update(a);
      if (next !== a) {
        tx.set(accountPath(id), next);
        this.audit(tx, actor, action, id);
      }
      return pick<MerchantAccount>(next, accountFields);
    });
  }
  async confirm(id: string, actor: string) {
    return this.mutate(id, actor, 'purchase.confirmed', (a) =>
      a.purchase_confirmed_at ? a : { ...a, purchase_confirmed_at: new Date() },
    );
  }
  async changeEmail(id: string, input: unknown, actor: string) {
    const value = emailCorrection.parse(input);
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, id);
      if (a.firebase_uid)
        throw new HttpError(
          409,
          'EMAIL_LINKED',
          'O lojista já vinculou sua conta. O e-mail de login precisa ser alterado pelo próprio titular.',
        );
      if (a.email === value.email) return pick<MerchantAccount>(a, accountFields);
      if (a.email !== value.expectedEmail)
        throw new HttpError(
          409,
          'ACCOUNT_CHANGED',
          'O cadastro mudou. Atualize a página antes de editar.',
        );
      const newPath = 'platform_emails/' + tokenHash(value.email),
        oldPath = 'platform_emails/' + tokenHash(a.email);
      const [existing, old] = await Promise.all([tx.get(newPath), tx.get(oldPath)]);
      if (existing && existing.account_id !== id)
        throw new HttpError(409, 'EMAIL_EXISTS', 'Já existe uma contratação com esse e-mail.');
      const next = {
        ...a,
        email: value.email,
        invitation_generation: (a.invitation_generation ?? 0) + 1,
      };
      tx.set(accountPath(id), next);
      tx.set(newPath, { account_id: id });
      if (old?.account_id === id) tx.delete(oldPath);
      this.audit(tx, actor, 'account.email_corrected', id);
      return pick<MerchantAccount>(next, accountFields);
    });
  }
  async approve(id: string, actor: string) {
    return this.mutate(id, actor, 'access.approved', (a) => {
      if (!a.purchase_confirmed_at || !a.firebase_uid)
        throw new HttpError(
          409,
          'APPROVAL_NOT_ALLOWED',
          'O lojista precisa aceitar o convite e a contratação deve estar confirmada.',
        );
      return a.access_status === 'approved'
        ? a
        : {
            ...a,
            access_status: 'approved',
            approved_at: a.approved_at || new Date(),
            suspension_reason: null,
            activation_pending: Boolean(
              a.bot_submitted_at && ['pending', 'configuring'].includes(a.bot_activation_status),
            ),
          };
    });
  }
  async suspend(id: string, reason: string, actor: string) {
    return this.mutate(id, actor, 'access.suspended', (a) => ({
      ...a,
      access_status: 'suspended',
      suspension_reason: reason,
      invitation_generation: a.invitation_generation + 1,
      activation_pending: false,
    }));
  }
  async restore(id: string, actor: string) {
    return this.mutate(id, actor, 'access.restored', (a) => {
      if (a.access_status !== 'suspended') return a;
      const status = a.firebase_uid && a.approved_at ? 'approved' : 'pending';
      return {
        ...a,
        access_status: status,
        suspension_reason: null,
        activation_pending:
          status === 'approved' &&
          Boolean(
            a.bot_submitted_at && ['pending', 'configuring'].includes(a.bot_activation_status),
          ),
      };
    });
  }
  async invite(id: string, actor: string) {
    const token = randomBytes(32).toString('base64url'),
      expires = new Date(Date.now() + this.inviteMs);
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, id);
      if (!a.purchase_confirmed_at || a.firebase_uid || a.access_status === 'suspended')
        throw new HttpError(
          409,
          'INVITE_NOT_ALLOWED',
          'Confirme a contratação e confira o vínculo antes de gerar o convite.',
        );
      const generation = a.invitation_generation + 1;
      tx.set(accountPath(id), { ...a, invitation_generation: generation });
      tx.set('merchant_invitations/' + tokenHash(token), {
        account_id: id,
        generation,
        expires_at: expires,
        used_at: null,
      });
      this.audit(tx, actor, 'invitation.created', id);
      return { token, expiresAt: expires };
    });
  }
  private available(invite: Doc | null, account: Doc) {
    return (
      invite &&
      !invite.used_at &&
      invite.expires_at > new Date() &&
      invite.generation === account.invitation_generation &&
      !account.firebase_uid &&
      account.purchase_confirmed_at &&
      account.access_status !== 'suspended'
    );
  }
  async inspect(token: string) {
    return this.store.transaction(async (tx) => {
      const invite = await tx.get('merchant_invitations/' + tokenHash(token));
      if (!invite) throw inviteError();
      const a = await this.account(tx, invite.account_id);
      if (!this.available(invite, a)) throw inviteError();
      const [local, domain] = a.email.split('@');
      return {
        storeName: a.store_name as string,
        emailHint: local.slice(0, 1) + '***@' + domain,
        expiresAt: invite.expires_at as Date,
      };
    });
  }
  async accept(token: string, identity: Identity) {
    if (!identity.emailVerified)
      throw new HttpError(
        403,
        'EMAIL_UNVERIFIED',
        'Confirme seu e-mail antes de aceitar o convite.',
      );
    return this.store.transaction(async (tx) => {
      const path = 'merchant_invitations/' + tokenHash(token),
        invite = await tx.get(path);
      if (!invite) throw inviteError();
      const a = await this.account(tx, invite.account_id),
        link = await tx.get(uidPath(identity.uid));
      if (
        invite.used_at &&
        a.firebase_uid === identity.uid &&
        link?.account_id === a.id &&
        a.email === identity.email.trim().toLowerCase()
      )
        return pick<MerchantAccount>(a, accountFields);
      if (!this.available(invite, a)) throw inviteError();
      if (a.email !== identity.email.trim().toLowerCase())
        throw new HttpError(
          403,
          'INVITE_EMAIL_MISMATCH',
          'Entre com o mesmo e-mail cadastrado na contratação.',
        );
      if (link)
        throw new HttpError(409, 'ALREADY_BOUND', 'Essa conta já está vinculada a uma loja.');
      const next = {
        ...a,
        firebase_uid: identity.uid,
        access_status: 'approved',
        approved_at: a.approved_at || new Date(),
        suspension_reason: null,
      };
      tx.set(accountPath(a.id), next);
      tx.set(uidPath(identity.uid), { account_id: a.id });
      tx.set(path, { ...invite, used_at: new Date() });
      this.audit(tx, identity.uid, 'invitation.accepted', a.id);
      this.audit(tx, identity.uid, 'access.approved_by_invitation', a.id);
      return pick<MerchantAccount>(next, accountFields);
    });
  }
  async consumeRate(bucket: string, limit: number, windowMs: number) {
    const hits = await this.store.transaction(async (tx) => {
      const path = 'api_rate_limits/' + tokenHash(bucket),
        old = await tx.get(path),
        now = new Date();
      const next =
        !old || old.expires_at <= now
          ? { hits: 1, expires_at: new Date(now.getTime() + windowMs) }
          : { ...old, hits: old.hits + 1 };
      tx.set(path, next);
      return next.hits;
    });
    if (hits > limit)
      throw new HttpError(
        429,
        'RATE_LIMIT',
        'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
      );
  }
  private editable(a: Doc) {
    if (a.access_status !== 'approved' || a.billing_started_at)
      throw new HttpError(
        409,
        'BOT_SETUP_LOCKED',
        'A configuração não pode ser alterada agora. Fale com a Blackout Create.',
      );
  }
  private async owner(uid: string) {
    const a = await this.own(uid);
    if (!a || a.access_status !== 'approved')
      throw new HttpError(
        403,
        'STORE_NOT_APPROVED',
        'Aguarde a liberação da sua loja para enviar os dados.',
      );
    return a;
  }
  private async readSetup(id: string): Promise<BotSetup | null> {
    const s = await this.store.get(setupPath(id));
    return s ? pick<BotSetup>(s, setupFields) : null;
  }
  private summary(a: Doc, setup: Doc) {
    return {
      ...a,
      bot_username: setup.bot_username,
      bot_activation_status: setup.activation_status,
      bot_submitted_at: setup.submitted_at,
      activation_pending:
        a.access_status === 'approved' &&
        Boolean(setup.submitted_at && ['pending', 'configuring'].includes(setup.activation_status)),
    };
  }
  private async saveBot(uid: string, input: z.infer<typeof botCredentials>) {
    this.vault.requireKey();
    const owner = await this.owner(uid);
    this.editable(owner);
    const bot = await this.verify(input.botToken),
      ciphertext = this.vault.seal(input.botToken, owner.id + ':' + bot.id);
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, owner.id),
        existing = await tx.get(setupPath(a.id)),
        binding = await tx.get('bot_links/' + bot.id);
      this.editable(a);
      if (existing?.activation_status === 'configuring')
        throw new HttpError(
          409,
          'BOT_CONFIGURING',
          'A equipe já está configurando seu bot. Peça a liberação para corrigir os dados.',
        );
      if (binding && binding.account_id !== a.id)
        throw new HttpError(
          409,
          'BOT_UNAVAILABLE',
          'Este bot não está disponível para vinculação.',
        );
      const setup: BotSetup = {
        bot_id: bot.id,
        bot_username: bot.username,
        telegram_user_id: input.telegramUserId,
        submitted_at: null,
        updated_at: new Date(),
        activation_status: 'pending',
        review_note: null,
        reviewed_at: null,
        activated_at: null,
        deployment_reference: null,
        revision: (existing?.revision || 0) + 1,
      };
      if (existing && existing.bot_id !== bot.id) tx.delete('bot_links/' + existing.bot_id);
      tx.set('bot_links/' + bot.id, { account_id: a.id });
      tx.set(setupPath(a.id), setup);
      tx.set('merchant_bot_secrets/' + a.id, { ciphertext });
      tx.set(accountPath(a.id), this.summary(a, setup));
      this.audit(tx, uid, 'bot_setup.saved', a.id);
      return setup;
    });
  }
  private async submitBot(uid: string) {
    const owner = await this.owner(uid);
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, owner.id),
        s = await tx.get(setupPath(a.id));
      this.editable(a);
      if (!s)
        throw new HttpError(
          409,
          'BOT_SETUP_MISSING',
          'Informe e valide os dados do bot antes de continuar.',
        );
      if (!s.submitted_at) {
        const next = {
          ...s,
          submitted_at: new Date(),
          updated_at: new Date(),
          revision: s.revision + 1,
        };
        tx.set(setupPath(a.id), next);
        tx.set(accountPath(a.id), this.summary(a, next));
        this.audit(tx, uid, 'bot_setup.submitted', a.id);
        return pick<BotSetup>(next, setupFields);
      }
      return pick<BotSetup>(s, setupFields);
    });
  }
  private current(s: Doc | null, revision: number) {
    if (!s?.submitted_at)
      throw new HttpError(
        409,
        'BOT_SETUP_MISSING',
        'O lojista precisa enviar os dados antes desta ação.',
      );
    if (s.revision !== revision)
      throw new HttpError(
        409,
        'BOT_SETUP_CHANGED',
        'Os dados foram atualizados. Atualize a página e confira novamente.',
      );
    return s;
  }
  private async reviewBot(
    id: string,
    actor: string,
    input: { action: 'configure' | 'request_changes'; revision: number; note: string },
  ) {
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, id),
        s = this.current(await tx.get(setupPath(id)), input.revision);
      this.editable(a);
      if (input.action === 'configure' && s.activation_status === 'changes_requested')
        throw new HttpError(
          409,
          'CORRECTION_PENDING',
          'Aguarde o lojista corrigir e reenviar os dados.',
        );
      const status = input.action === 'configure' ? 'configuring' : 'changes_requested';
      if (s.activation_status === status && s.review_note === (input.note || null))
        return pick<BotSetup>(s, setupFields);
      const next = {
        ...s,
        activation_status: status,
        review_note: input.note || null,
        reviewed_at: new Date(),
        updated_at: new Date(),
        revision: s.revision + 1,
      };
      tx.set(setupPath(id), next);
      tx.set(accountPath(id), this.summary(a, next));
      this.audit(tx, actor, 'bot_setup.' + status, id);
      return pick<BotSetup>(next, setupFields);
    });
  }
  private async activateBot(
    id: string,
    actor: string,
    input: { revision: number; deploymentReference: string },
  ) {
    this.vault.requireKey();
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, id),
        setup = await tx.get(setupPath(id)),
        path = 'square_app_links/' + tokenHash(input.deploymentReference),
        binding = await tx.get(path);
      if (a.access_status !== 'approved' || !a.purchase_confirmed_at || !a.firebase_uid)
        throw new HttpError(
          409,
          'ACTIVATION_NOT_ALLOWED',
          'Confirme a contratação e libere o acesso do lojista antes da ativação.',
        );
      if (
        setup?.activation_status === 'active' &&
        setup.deployment_reference === input.deploymentReference
      )
        return {
          setup: pick<BotSetup>(setup, setupFields),
          account: pick<MerchantAccount>(a, accountFields),
        };
      const s = this.current(setup, input.revision);
      if (a.billing_started_at || s.activation_status !== 'configuring')
        throw new HttpError(
          409,
          'ACTIVATION_NOT_ALLOWED',
          'Marque o bot em configuração antes de confirmar.',
        );
      if (binding && binding.account_id !== id)
        throw new HttpError(
          409,
          'DEPLOYMENT_ALREADY_LINKED',
          'Este aplicativo da Square Cloud já está vinculado a outro cliente.',
        );
      const now = new Date(),
        next = {
          ...s,
          activation_status: 'active',
          activated_at: now,
          deployment_reference: input.deploymentReference,
          review_note: null,
          updated_at: now,
          revision: s.revision + 1,
        };
      const account = {
        ...this.summary(a, next),
        billing_started_at: now,
        paid_through: nextBillingMonth(now, a.billing_months ?? 1),
      };
      tx.set(path, { account_id: id });
      tx.set(setupPath(id), next);
      tx.set(accountPath(id), account);
      this.audit(
        tx,
        actor,
        actor === 'automatic-activation'
          ? 'bot_activation.confirmed_automatically'
          : 'bot_activation.confirmed_manually',
        id,
      );
      return {
        setup: pick<BotSetup>(next, setupFields),
        account: pick<MerchantAccount>(account, accountFields),
      };
    });
  }
  private async revealBot(id: string, actor: string) {
    this.vault.requireKey();
    return this.store.transaction(async (tx) => {
      const a = await this.account(tx, id),
        s = await tx.get(setupPath(id)),
        secret = await tx.get('merchant_bot_secrets/' + id);
      if (a.access_status !== 'approved')
        throw new HttpError(409, 'BOT_SETUP_LOCKED', 'A loja precisa estar liberada.');
      if (!s?.submitted_at || !secret)
        throw new HttpError(
          409,
          'BOT_SETUP_MISSING',
          'O lojista ainda não enviou os dados para ativação.',
        );
      const token = this.vault.open(secret.ciphertext, id + ':' + s.bot_id);
      this.audit(tx, actor, 'bot_token.accessed', id);
      return token;
    });
  }
}
