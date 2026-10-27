import { HyzeHosting, buildHyzeRuntimeArchive } from './hyze-hosting.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { botTransaction } from './bot-data.js';
import type { BotStore } from './bot-store.js';
import type { Doc } from './document-store.js';
import type { OnboardingService } from './platform-contract.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
import { TelegramClient } from './telegram-client.js';
import { HostingError, type HostingProvider } from './square-hosting.js';

const settingsPath = 'platform_hosting/hyze';
const jobPath = (id: string) => 'bot_activation_jobs/' + id;
const messages: Record<string, string> = {
  queued: 'Preparando a hospedagem do seu bot.',
  checking: 'Validando o bot e a disponibilidade da hospedagem.',
  uploading: 'Publicando seu bot. Aguarde a confirmação da hospedagem.',
  configuring: 'Conectando o aplicativo à sua loja.',
  waiting_owner: 'Confirme sua conta no Telegram para concluir a ativação.',
  active: 'Bot ativado. Seu período contratado começou.',
  action_required: 'A Blackout precisa conferir a ativação. Seu período ainda não começou.',
  uncertain: 'Estamos conferindo a publicação com a hospedagem. Não reenvie os dados.',
};
export class AutomaticActivation {
  private vault: SecretVault;
  constructor(
    private bots: BotStore,
    private onboarding: OnboardingService,
    key: string,
    private origin: string,
    private provider: (key: string) => HostingProvider = (key) => new HyzeHosting(key),
    private inspect: (token: string) => Promise<{ id: string; webhook: boolean }> = async (
      token,
    ) => {
      const telegram = new TelegramClient(token),
        me = await telegram.call<{ id: number; is_bot: boolean }>('getMe'),
        webhook = await telegram.call<{ url: string }>('getWebhookInfo');
      return { id: me.is_bot ? String(me.id) : '', webhook: Boolean(webhook.url) };
    },
    private archive = buildHyzeRuntimeArchive,
    private now = () => new Date(),
  ) {
    this.vault = new SecretVault(key);
  }
  private get store() {
    return this.bots.store;
  }
  async settings() {
    const settings = await this.store.get(settingsPath);
    return {
      connected: Boolean(settings?.ciphertext),
      enabled: settings?.enabled === true,
      memoryPerBot: 256,
      provider: 'hyze',
    };
  }
  async connect(actor: string, raw: unknown) {
    const input = z
      .object({
        apiKey: z
          .string()
          .trim()
          .min(20)
          .max(512)
          .regex(/^[!-~]+$/),
        enabled: z.boolean(),
      })
      .strict()
      .parse(raw);
    await this.provider(input.apiKey).account();
    await botTransaction(this.store, async (tx) => {
      tx.set(settingsPath, {
        ciphertext: this.vault.seal(input.apiKey, 'hyze-hosting'),
        enabled: input.enabled,
        updated_at: this.now(),
      });
      const id = randomUUID();
      tx.set('platform_audit/' + id, {
        id,
        actor_uid: actor,
        account_id: null,
        action: 'hosting.connected',
        created_at: this.now(),
      });
    });
    return this.settings();
  }
  async pause() {
    await botTransaction(this.store, async (tx) => {
      const settings = await tx.get(settingsPath);
      if (settings) tx.set(settingsPath, { ...settings, enabled: false });
    });
    return this.settings();
  }
  async enqueue(id: string) {
    return botTransaction(this.store, async (tx) => {
      const account = await tx.get('merchant_accounts/' + id),
        setup = await tx.get('merchant_bot_setup/' + id),
        existing = await tx.get(jobPath(id)),
        runtime = await tx.get('bot_runtimes/' + id),
        settings = await tx.get(settingsPath);
      if (!settings?.enabled) return;
      if (
        !account?.firebase_uid ||
        !account.purchase_confirmed_at ||
        account.access_status !== 'approved' ||
        !setup?.submitted_at ||
        setup.activation_status !== 'pending' ||
        account.billing_started_at
      )
        return;
      if (existing || runtime) return;
      tx.set(jobPath(id), {
        id,
        bot_id: setup.bot_id,
        telegram_id: setup.telegram_user_id,
        provider: 'hyze',
        stage: 'queued',
        name: 'Blackout-' + id,
        created_at: this.now(),
        updated_at: this.now(),
        resume: 'checking',
      });
    });
  }
  async status(id: string) {
    const job = await this.store.get(jobPath(id));
    if (job && job.provider !== 'hyze')
      return {
        stage: 'action_required',
        message:
          'Esta ativação pertence à hospedagem anterior. A Blackout precisa conferir a migração.',
        updatedAt: job.updated_at,
        code: 'LEGACY_HOSTING_JOB',
      };
    return job
      ? {
          stage: String(job.stage),
          message: messages[job.stage] ?? messages.action_required,
          updatedAt: job.updated_at,
          code: job.error_code ?? null,
        }
      : null;
  }
  async retry(id: string) {
    await botTransaction(this.store, async (tx) => {
      const job = await tx.get(jobPath(id));
      if (!job || job.provider !== 'hyze' || !['action_required', 'uncertain'].includes(job.stage))
        throw new HttpError(
          409,
          'ACTIVATION_NOT_RETRYABLE',
          'Atualize o acompanhamento da ativação.',
        );
      // Ambiguous upload is reconciliation-only: never submit a second application.
      tx.set(jobPath(id), { ...job, stage: job.resume, error_code: null, updated_at: this.now() });
    });
    return this.status(id);
  }
  private async save(id: string, patch: Doc) {
    await botTransaction(this.store, async (tx) => {
      const job = await tx.get(jobPath(id));
      if (job) tx.set(jobPath(id), { ...job, ...patch, updated_at: this.now() });
    });
  }
  private async eligible(id: string, job: Doc) {
    const account = await this.store.get('merchant_accounts/' + id),
      setup = await this.store.get('merchant_bot_setup/' + id);
    if (
      !account?.purchase_confirmed_at ||
      !account.firebase_uid ||
      account.access_status !== 'approved' ||
      !setup?.submitted_at ||
      setup.bot_id !== job.bot_id ||
      setup.telegram_user_id !== job.telegram_id ||
      !['pending', 'configuring', 'active'].includes(setup.activation_status)
    )
      throw new HostingError('LIFECYCLE_CHANGED');
    return { account, setup };
  }
  async tick() {
    const lease = randomUUID();
    const settings = await botTransaction(this.store, async (tx) => {
      const config = await tx.get(settingsPath),
        lock = await tx.get('platform_hosting/activation_lease');
      if (!config?.enabled || !config.ciphertext || (lock?.until && lock.until > this.now()))
        return null;
      tx.set('platform_hosting/activation_lease', {
        lease,
        until: new Date(this.now().getTime() + 300000),
      });
      return config;
    });
    if (!settings) return;
    try {
      // Bound each scan and retain a cursor so completed stores cannot starve new ones.
      const cursor = (await this.store.get('platform_hosting/activation_cursor'))?.after ?? '';
      const jobs = await this.store.list('bot_activation_jobs', { limit: 25, afterId: cursor });
      let after = '';
      for (const job of jobs) {
        after = job.id;
        if (job.provider !== 'hyze') continue;
        if (!['active', 'action_required', 'uncertain'].includes(job.stage)) {
          await this.process(job, settings);
          break;
        }
      }
      await botTransaction(this.store, async (tx) => {
        tx.set('platform_hosting/activation_cursor', { after });
      });
    } finally {
      await botTransaction(this.store, async (tx) => {
        if ((await tx.get('platform_hosting/activation_lease'))?.lease === lease)
          tx.delete('platform_hosting/activation_lease');
      });
    }
  }
  private async process(job: Doc, settings: Doc) {
    const id = job.id;
    let resume = job.stage;
    try {
      const provider = this.provider(this.vault.open(settings.ciphertext, 'hyze-hosting'));
      let { setup } = await this.eligible(id, job);
      if (['queued', 'checking'].includes(job.stage)) {
        resume = 'checking';
        await this.save(id, { stage: 'checking', resume });
        const secret = await this.store.get('merchant_bot_secrets/' + id);
        if (!secret) throw new HostingError('TOKEN_MISSING');
        const identity = await this.inspect(
          this.vault.open(secret.ciphertext, id + ':' + setup.bot_id),
        );
        if (identity.id !== setup.bot_id || identity.webhook)
          throw new HostingError(identity.webhook ? 'EXISTING_WEBHOOK' : 'BOT_IDENTITY_CHANGED');
        const resources = await provider.account();
        if (resources.available < 256) throw new HostingError('INSUFFICIENT_MEMORY');
        // Build before marking the upload started; local packaging errors can retry safely.
        const archive = await this.archive(job.name);
        if (setup.activation_status === 'pending') {
          await this.onboarding.review(id, 'automatic-activation', {
            action: 'configure',
            revision: setup.revision,
            note: '',
          });
        }
        await this.eligible(id, job);
        resume = 'uploading';
        await this.save(id, { stage: 'uploading', resume });
        try {
          job.application_id = await provider.upload(archive, job.name);
        } catch (e) {
          // Only an explicit capacity/auth rejection is safe to resubmit later.
          if (
            e instanceof HostingError &&
            !e.uncertain &&
            [
              'INSUFFICIENT_MEMORY',
              'MISSING_SCOPE',
              'RESOURCE_NOT_ALLOWED',
              'ACCESS_DENIED',
              'RATE_LIMITED',
            ].includes(e.code)
          )
            resume = 'checking';
          throw e;
        }
        await this.save(id, {
          stage: 'configuring',
          resume: 'configuring',
          application_id: job.application_id,
        });
        job.stage = 'configuring';
      }
      if (job.stage === 'uploading') {
        resume = 'uploading';
        const candidates = (await provider.account()).apps.filter((app) => app.name === job.name);
        if (candidates.length !== 1 || !/^[A-Za-z0-9_-]{6,120}$/.test(candidates[0].id))
          throw new HostingError('UPLOAD_NEEDS_RECONCILIATION', true);
        job.application_id = candidates[0].id;
        job.stage = 'configuring';
        await this.save(id, {
          stage: 'configuring',
          resume: 'configuring',
          application_id: job.application_id,
        });
      }
      if (job.stage === 'configuring') {
        resume = 'configuring';
        await this.eligible(id, job);
        let key = job.runtime_key_ciphertext
          ? this.vault.open(job.runtime_key_ciphertext, 'activation:' + id)
          : '';
        if (!key) {
          key = await this.bots.provision(id, job.application_id);
          await this.save(id, { runtime_key_ciphertext: this.vault.seal(key, 'activation:' + id) });
        }
        await provider.configure(job.application_id, {
          NODE_ENV: 'production',
          PORT: '80',
          BOT_API_ORIGIN: this.origin,
          BOT_RUNTIME_KEY: key,
        });
        await this.save(id, { stage: 'waiting_owner', resume: 'waiting_owner' });
        return;
      }
      if (job.stage === 'waiting_owner') {
        resume = 'waiting_owner';
        const status = await this.bots.status(id);
        const runtime = await this.store.get('bot_runtimes/' + id);
        if (
          !status.provisioned ||
          runtime?.application_id !== job.application_id ||
          !status.online ||
          !status.ownerVerified ||
          !(await provider.running(job.application_id))
        )
          return;
        ({ setup } = await this.eligible(id, job));
        await this.onboarding.activate(id, 'automatic-activation', {
          revision: setup.revision,
          deploymentReference: job.application_id,
        });
        await this.save(id, {
          stage: 'active',
          resume: 'active',
          runtime_key_ciphertext: null,
          error_code: null,
        });
      }
    } catch (error) {
      await this.save(id, {
        stage: resume === 'uploading' ? 'uncertain' : 'action_required',
        resume,
        error_code: error instanceof HostingError ? error.code : 'ACTIVATION_CHECK_REQUIRED',
      });
    }
  }
}
