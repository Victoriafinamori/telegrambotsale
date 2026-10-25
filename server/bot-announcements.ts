import { randomBytes } from 'node:crypto';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import type {
  Announcement,
  BotEffect,
  RuntimeAccess,
  Shop,
  TelegramMethod,
  TelegramUpdate,
} from './bot-types.js';
import type { SecretVault } from './secret-vault.js';
import { botRoot, botPath, botButtons, botTransaction } from './bot-data.js';

interface NoticeContext {
  tx: DocumentTransaction;
  accountId: string;
  shop: Shop;
  customer: Doc;
  userId: string;
  owner: boolean;
  selling: boolean;
  message: TelegramUpdate['message'];
  now: Date;
  say: (text: string, markup?: ReturnType<typeof botButtons>) => void;
  emit: (method: TelegramMethod, payload: Record<string, unknown>) => string;
  audit: (action: string) => void;
}
type Guard = (
  tx: DocumentTransaction,
  auth: RuntimeAccess,
) => Promise<{ shop: Shop; account: Doc; setup: Doc }>;
const labels = {
  draft: 'Rascunho',
  queued: 'Na fila',
  sending: 'Enviando',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};
const noticePath = (id: string, notice: string) => botPath(id, 'announcements', notice);
export class BotAnnouncements {
  constructor(
    private store: DocumentStore,
    private vault: SecretVault,
    private now: () => Date,
    private guard: Guard,
  ) {}

  private preview(ctx: NoticeContext, notice: Announcement) {
    const text = `PRÉVIA DO AVISO\n\n${notice.text}`;
    const rows: [string, string][][] =
      notice.status === 'draft'
        ? [
            [
              [
                `Enviar para ${ctx.shop.notice_subscribers ?? 0} inscritos`,
                `admin:notice-send:${notice.id}`,
              ],
            ],
            [
              ['Editar texto', `admin:notice-edit:${notice.id}`],
              ['Trocar foto', `admin:notice-photo:${notice.id}`],
            ],
            [['Descartar aviso', `admin:notice-cancel:${notice.id}`]],
          ]
        : [];
    rows.push([['Voltar', 'admin:notices']]);
    ctx.emit(notice.photo ? 'sendPhoto' : 'sendMessage', {
      chat_id: ctx.userId,
      ...(notice.photo ? { photo: notice.photo, caption: text } : { text }),
      reply_markup: botButtons(rows),
    });
  }
  private createDraft(ctx: NoticeContext, photo: string) {
    const id = randomBytes(6).toString('hex');
    const notice: Announcement = {
      id,
      text: ctx.customer.session.text,
      photo,
      status: 'draft',
      created_at: ctx.now,
      audience_at: null,
      cursor: '',
      scan_complete: false,
      queued: 0,
      sent: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    };
    ctx.tx.set(noticePath(ctx.accountId, id), notice);
    ctx.shop.notice_recent = [id, ...(ctx.shop.notice_recent ?? [])].slice(0, 10);
    ctx.customer.session = null;
    ctx.audit('bot_notice.draft_created');
    this.preview(ctx, notice);
  }
  async action(ctx: NoticeContext, action: string) {
    if (!ctx.owner || !action.startsWith('notice')) return false;
    if (action === 'notices') {
      ctx.customer.session = null;
      ctx.say(
        `Avisos da loja\n${ctx.shop.notice_subscribers ?? 0} cliente(s) ativaram o recebimento.\nO envio só começa depois da sua confirmação.`,
        botButtons([
          [['Criar aviso', 'admin:notice-new']],
          [['Histórico de avisos', 'admin:notice-history']],
          [['Voltar', 'admin']],
        ]),
      );
    } else if (action === 'notice-new') {
      ctx.customer.session = { step: 'notice_text' };
      ctx.say(
        'Envie o texto do aviso, com até 900 caracteres. Depois você poderá adicionar uma foto opcional. /cancelar sai sem enviar.',
      );
    } else if (action === 'notice-no-photo' && ctx.customer.session?.step === 'notice_photo')
      this.createDraft(ctx, '');
    else if (action === 'notice-history') {
      const notices = await Promise.all(
        (ctx.shop.notice_recent ?? []).map((id) => ctx.tx.get(noticePath(ctx.accountId, id))),
      );
      const rows = notices
        .filter(Boolean)
        .map(
          (n) =>
            [
              [
                `${labels[(n as Announcement).status]} · ${String(n!.text).slice(0, 28)}`,
                `admin:notice-view:${n!.id}`,
              ],
            ] as [string, string][],
        );
      ctx.say(
        rows.length ? 'Avisos recentes:' : 'Você ainda não criou avisos.',
        botButtons([...rows, [['Voltar', 'admin:notices']]]),
      );
    } else {
      const match = /^notice-(view|send|edit|photo|cancel):([a-f0-9]{12})$/.exec(action);
      if (!match) return true;
      const [, operation, id] = match,
        notice = (await ctx.tx.get(noticePath(ctx.accountId, id))) as Announcement | null;
      if (!notice) {
        ctx.say('Aviso não encontrado nesta loja.');
        return true;
      }
      if (operation === 'view') {
        if (notice.status === 'draft') this.preview(ctx, notice);
        else
          ctx.say(
            `Aviso ${notice.id}\nEstado: ${labels[notice.status]}\nNa fila: ${notice.queued}\nEnviados: ${notice.sent}\nFalhas: ${notice.failed}\nResultado incerto: ${notice.uncertain}\nIgnorados: ${notice.skipped}\n${notice.scan_complete ? 'Público processado.' : 'Público em processamento.'}`,
            botButtons([
              ...(['queued', 'sending'].includes(notice.status)
                ? [
                    [['Cancelar próximos envios', `admin:notice-cancel:${id}`]] as [
                      string,
                      string,
                    ][],
                  ]
                : []),
              [['Voltar', 'admin:notice-history']],
            ]),
          );
      } else if (operation === 'edit' || operation === 'photo') {
        if (notice.status !== 'draft')
          ctx.say('Só é possível editar um rascunho. Crie outro aviso para uma nova mensagem.');
        else {
          ctx.customer.session = {
            step: operation === 'edit' ? 'notice_edit' : 'notice_replace_photo',
            notice_id: id,
          };
          ctx.say(
            operation === 'edit'
              ? 'Envie o novo texto (até 900 caracteres).'
              : 'Envie a nova foto, ou remover para deixar o aviso só em texto.',
          );
        }
      } else if (operation === 'send') {
        if (notice.status !== 'draft')
          ctx.say('Este aviso já foi confirmado ou encerrado. Consulte o histórico.');
        else if (!ctx.selling)
          ctx.say('Ative a loja e mantenha a assinatura válida antes de enviar avisos.');
        else if (ctx.shop.notice_active)
          ctx.say('Já existe um aviso em envio. Aguarde ou cancele pelo histórico.');
        else if (!(ctx.shop.notice_subscribers ?? 0))
          ctx.say('Nenhum cliente ativou o recebimento de avisos. O rascunho continua salvo.');
        else {
          notice.status = 'queued';
          notice.audience_at = ctx.now;
          ctx.shop.notice_active = id;
          ctx.tx.set(noticePath(ctx.accountId, id), notice);
          ctx.audit('bot_notice.confirmed');
          ctx.say(
            'Aviso confirmado. O envio será feito em lotes e pode ser acompanhado no histórico.',
            botButtons([[['Acompanhar', `admin:notice-view:${id}`]]]),
          );
        }
      } else if (operation === 'cancel') {
        if (notice.status === 'completed' || notice.status === 'cancelled')
          ctx.say('Este aviso já foi encerrado.');
        else {
          notice.status = 'cancelled';
          ctx.tx.set(noticePath(ctx.accountId, id), notice);
          if (ctx.shop.notice_active === id) ctx.shop.notice_active = null;
          ctx.audit('bot_notice.cancelled');
          ctx.say(
            'Próximos envios cancelados. Mensagens já enviadas ou em transmissão podem chegar.',
          );
        }
      }
    }
    return true;
  }
  async input(ctx: NoticeContext, text: string) {
    if (!ctx.owner || !ctx.customer.session?.step?.startsWith('notice_')) return false;
    const session = ctx.customer.session;
    if (session.step === 'notice_text') {
      if (!text || text.length > 900) ctx.say('Envie de 1 a 900 caracteres.');
      else {
        ctx.customer.session = { step: 'notice_photo', text };
        ctx.say(
          'Envie uma foto para o aviso, ou escolha Sem foto. Nada foi enviado aos clientes.',
          botButtons([[['Sem foto', 'admin:notice-no-photo']]]),
        );
      }
    } else if (session.step === 'notice_photo') {
      const photo = ctx.message?.photo?.at(-1);
      if (photo) this.createDraft(ctx, photo.file_id);
      else ctx.say('Envie uma foto ou use o botão Sem foto.');
    } else {
      const notice = (await ctx.tx.get(
        noticePath(ctx.accountId, session.notice_id),
      )) as Announcement | null;
      if (!notice || notice.status !== 'draft') {
        ctx.customer.session = null;
        ctx.say('Este rascunho não está disponível.');
      } else if (session.step === 'notice_edit') {
        if (!text || text.length > 900) ctx.say('Envie de 1 a 900 caracteres.');
        else {
          notice.text = text;
          ctx.tx.set(noticePath(ctx.accountId, notice.id), notice);
          ctx.customer.session = null;
          this.preview(ctx, notice);
        }
      } else {
        const photo = ctx.message?.photo?.at(-1);
        if (photo || text.toLowerCase() === 'remover') {
          notice.photo = photo?.file_id ?? '';
          ctx.tx.set(noticePath(ctx.accountId, notice.id), notice);
          ctx.customer.session = null;
          this.preview(ctx, notice);
        } else ctx.say('Envie uma foto ou remover.');
      }
    }
    return true;
  }

  async subscribe(
    tx: DocumentTransaction,
    id: string,
    shop: Shop,
    userId: string,
    enabled: boolean,
  ) {
    const target = botPath(id, 'subscribers', userId),
      previous = await tx.get(target);
    if (Boolean(previous?.enabled) !== enabled)
      shop.notice_subscribers = Math.max(0, (shop.notice_subscribers ?? 0) + (enabled ? 1 : -1));
    tx.set(target, {
      id: userId,
      enabled,
      subscribed_at:
        enabled && !previous?.enabled ? this.now() : (previous?.subscribed_at ?? this.now()),
    });
  }
  // Cursor pagination and deterministic effect IDs make restarts and concurrent
  // pumps safe, with no unbounded list or browser-supplied recipient addresses.
  async pump(auth: RuntimeAccess) {
    const shop = await this.store.get(botRoot(auth.accountId));
    if (!shop?.notice_active) return;
    const notice = (await this.store.get(
      noticePath(auth.accountId, shop.notice_active),
    )) as Announcement | null;
    if (!notice || notice.scan_complete || !['queued', 'sending'].includes(notice.status)) return;
    const subscribers = await this.store.list(botRoot(auth.accountId) + '/subscribers', {
      limit: 20,
      equals: ['enabled', true],
      afterId: notice.cursor,
    });
    await botTransaction(this.store, async (tx) => {
      const { shop: current, account, setup } = await this.guard(tx, auth),
        fresh = (await tx.get(noticePath(auth.accountId, notice.id))) as Announcement | null;
      if (
        !fresh ||
        current.notice_active !== notice.id ||
        fresh.cursor !== notice.cursor ||
        fresh.scan_complete ||
        !['queued', 'sending'].includes(fresh.status)
      )
        return;
      if (
        account.access_status !== 'approved' ||
        setup.activation_status !== 'active' ||
        !account.paid_through ||
        account.paid_through <= this.now()
      ) {
        fresh.status = 'cancelled';
        current.notice_active = null;
        tx.set(noticePath(auth.accountId, fresh.id), fresh);
        tx.set(botRoot(auth.accountId), current);
        return;
      }
      for (const candidate of subscribers) {
        const member = await tx.get(botPath(auth.accountId, 'subscribers', candidate.id));
        const effectId = `n${fresh.id}_${candidate.id}`,
          target = botPath(auth.accountId, 'effects', effectId),
          existing = await tx.get(target);
        if (
          !member?.enabled ||
          !fresh.audience_at ||
          member.subscribed_at > fresh.audience_at ||
          existing
        )
          continue;
        const payload = {
          chat_id: candidate.id,
          ...(fresh.photo ? { photo: fresh.photo, caption: fresh.text } : { text: fresh.text }),
        };
        tx.set(target, {
          id: effectId,
          method: fresh.photo ? 'sendPhoto' : 'sendMessage',
          status: 'pending',
          announcement_id: fresh.id,
          recipient_id: candidate.id,
          created_at: this.now(),
          payload_ciphertext: this.vault.seal(
            JSON.stringify(payload),
            `${auth.accountId}:effect:${effectId}`,
          ),
        });
        fresh.queued++;
      }
      fresh.cursor = subscribers.at(-1)?.id ?? fresh.cursor;
      fresh.scan_complete = subscribers.length < 20;
      fresh.status = 'sending';
      this.complete(current, fresh);
      tx.set(noticePath(auth.accountId, fresh.id), fresh);
      tx.set(botRoot(auth.accountId), current);
    });
  }
  private complete(shop: Shop, notice: Announcement) {
    if (
      notice.status !== 'cancelled' &&
      notice.scan_complete &&
      notice.sent + notice.failed + notice.uncertain + notice.skipped >= notice.queued
    ) {
      notice.status = 'completed';
      if (shop.notice_active === notice.id) shop.notice_active = null;
    }
  }
  async canSend(tx: DocumentTransaction, auth: RuntimeAccess, shop: Shop, out: BotEffect) {
    if (!out.announcement_id) return true;
    const notice = (await tx.get(
      noticePath(auth.accountId, out.announcement_id),
    )) as Announcement | null;
    const member = out.recipient_id
      ? await tx.get(botPath(auth.accountId, 'subscribers', out.recipient_id))
      : null;
    return Boolean(
      notice &&
        ['queued', 'sending'].includes(notice.status) &&
        member?.enabled &&
        notice.audience_at &&
        member.subscribed_at <= notice.audience_at,
    );
  }
  async finish(
    tx: DocumentTransaction,
    auth: RuntimeAccess,
    shop: Shop,
    out: BotEffect,
    result: 'sent' | 'failed' | 'uncertain' | 'skipped',
    errorCode?: number,
  ) {
    if (!out.announcement_id) return;
    const notice = (await tx.get(
      noticePath(auth.accountId, out.announcement_id),
    )) as Announcement | null;
    if (!notice) return;
    notice[result]++;
    if (errorCode === 403 && out.recipient_id)
      await this.subscribe(tx, auth.accountId, shop, out.recipient_id, false);
    this.complete(shop, notice);
    tx.set(noticePath(auth.accountId, notice.id), notice);
    tx.set(botRoot(auth.accountId), shop);
  }
}
