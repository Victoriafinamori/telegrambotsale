import { randomUUID } from 'node:crypto';
import type { BotEffect, TelegramUpdate } from './bot-types.js';
import type { DocumentStore } from './document-store.js';
import type { NavigationSnapshot } from './local-navigation.js';
import { reuseNavigationMessage } from './bot-navigation.js';
import { parsePrice, money } from './bot-appearance.js';
import {
  configurationCommit,
  shopConfigurationChange,
  type ShopConfigurationChange,
} from './shop-configuration.js';

const fields = {
  welcome: 'Boas-vindas',
  banner: 'Banner da loja',
  support_name: 'Nome do suporte',
  support_phone: 'Telefone do suporte',
  support: 'Telegram do suporte',
  support_url: 'Link do suporte',
  product_description: 'Descrição do produto',
  product_banner: 'Banner do produto',
  product_price: 'Preço do produto',
} as const;
type Field = keyof typeof fields;
type Draft = {
  ownerId: string;
  generation: string;
  revision: string;
  field: Field;
  productId?: string;
  command?: ReturnType<typeof configurationCommit.parse>;
};

// Local draft editor. Only explicit Save calls the central service; financial and
// stock commands are never interpreted here. No success before central acknowledgment.
export class LocalShopEditor {
  private snapshot: NavigationSnapshot | null = null;
  private readonly statePath: string;
  constructor(
    private store: DocumentStore,
    private accountId: string,
    private commit: (
      command: ReturnType<typeof configurationCommit.parse>,
    ) => Promise<{ snapshot: NavigationSnapshot | null }>,
    private now = () => Date.now(),
  ) {
    this.statePath = 'bot_shops/' + accountId + '/local/editor';
  }
  install(snapshot: NavigationSnapshot | null) {
    if (snapshot && snapshot.accountId !== this.accountId) throw Error('Editor shop mismatch');
    this.snapshot = snapshot;
  }
  invalidate() {
    this.snapshot = null;
  }
  private async save(draft: Draft | null) {
    await this.store.transaction(async (tx) => tx.set(this.statePath, { draft }));
  }
  async handle(update: TelegramUpdate): Promise<BotEffect[] | null> {
    const snapshot = this.snapshot,
      cb = update.callback_query,
      msg = update.message;
    const from = cb?.from ?? msg?.from,
      chat = cb?.message?.chat ?? msg?.chat;
    if (
      !snapshot ||
      snapshot.expiresAt <= this.now() ||
      !snapshot.ownerVerified ||
      !snapshot.generation ||
      !snapshot.revision ||
      !from ||
      from.is_bot ||
      !chat ||
      chat.type !== 'private' ||
      chat.id !== from.id ||
      String(from.id) !== snapshot.ownerId ||
      msg?.successful_payment ||
      msg?.refunded_payment ||
      update.pre_checkout_query
    )
      return null;
    const text = msg?.text?.trim() ?? '',
      cmd = cb?.data ?? text;
    const buttons = (rows: [string, string][][]) => ({
      inline_keyboard: rows.map((row) =>
        row.map(([text, callback_data]) => ({ text, callback_data })),
      ),
    });
    const respond = (
      text: string,
      rows: [string, string][][] = [[['‹ Personalizar loja', 'lc:menu']], [['Fechar', 'admin']]],
    ): BotEffect[] => {
      const effects: BotEffect[] = [
        ...(cb
          ? [
              {
                id: 'lc_ack_' + update.update_id,
                method: 'answerCallbackQuery' as const,
                status: 'pending' as const,
                payload: { callback_query_id: cb.id },
              },
            ]
          : []),
        {
          id: 'lc_screen_' + update.update_id,
          method: 'sendMessage',
          status: 'pending',
          payload: { chat_id: chat.id, text, reply_markup: buttons(rows) },
        },
      ];
      if (cb)
        reuseNavigationMessage({ ...update, callback_query: { ...cb, data: 'admin' } }, effects);
      return effects;
    };
    let draft = (await this.store.get(this.statePath))?.draft as Draft | null;
    if (draft && (draft.ownerId !== snapshot.ownerId || draft.generation !== snapshot.generation)) {
      await this.save(null);
      draft = null;
    }
    const localCommand = cmd === '/configurar' || cmd.startsWith('lc:');
    if (snapshot.ownerHasCentralSession) {
      if (localCommand)
        return respond(
          'Você tem uma etapa em andamento.\n\nEnvie /cancelar para encerrá-la. Depois envie /configurar.',
        );
      return null;
    }
    if (cmd === 'lc:menu' || cmd === '/configurar' || cmd === 'lc:cancel') {
      await this.save(null);
      return respond(
        '⚙️ Personalizar loja\n\nEscolha o que deseja alterar. Os ajustes ficam em rascunho até você tocar em Salvar.\n\nO nome do bot é definido no BotFather.',
        [
          [
            ['Boas-vindas', 'lc:field:welcome'],
            ['Banner', 'lc:field:banner'],
          ],
          [
            ['Nome do suporte', 'lc:field:support_name'],
            ['Telefone', 'lc:field:support_phone'],
          ],
          [
            ['Telegram do suporte', 'lc:field:support'],
            ['Link de suporte', 'lc:field:support_url'],
          ],
          [['Personalizar produtos', 'lc:products:0']],
          [['‹ Administração', 'admin']],
        ],
      );
    }
    if (cmd.startsWith('lc:products:')) {
      await this.save(null);
      const page = Math.min(
        Math.max(0, Math.floor(Number(cmd.split(':')[2]) || 0)),
        Math.max(0, Math.ceil(snapshot.shop.products.length / 8) - 1),
      );
      const products = snapshot.shop.products.slice(page * 8, page * 8 + 8);
      return respond(
        products.length
          ? 'Produtos da loja\n\nEscolha um produto para editar descrição, banner ou preço.'
          : 'Nenhum produto disponível para editar. Cadastre um produto pela administração.',
        [
          ...products.map(
            (p) => [[p.title.slice(0, 45), 'lc:product:' + p.id]] as [string, string][],
          ),
          ...(page > 0
            ? [[['‹ Anterior', 'lc:products:' + (page - 1)]] as [string, string][]]
            : []),
          ...(snapshot.shop.products.length > (page + 1) * 8
            ? [[['Próxima ›', 'lc:products:' + (page + 1)]] as [string, string][]]
            : []),
          [['‹ Personalizar loja', 'lc:menu']],
        ],
      );
    }
    if (cmd.startsWith('lc:product:')) {
      await this.save(null);
      const product = snapshot.shop.products.find((p) => p.id === cmd.slice(11));
      if (!product) return respond('Produto indisponível. Atualize o catálogo.');
      return respond(
        product.title +
          '\n\nPreço atual: ' +
          money(product.price, snapshot.shop.payment_mode === 'manual' ? 'BRL' : 'XTR'),
        [
          [
            ['Descrição', 'lc:field:product_description:' + product.id],
            ['Banner', 'lc:field:product_banner:' + product.id],
          ],
          [['Preço', 'lc:field:product_price:' + product.id]],
          [['‹ Produtos', 'lc:products:0']],
        ],
      );
    }
    if (cmd.startsWith('lc:field:')) {
      const [, , raw, productId] = cmd.split(':'),
        field = raw as Field;
      if (!Object.hasOwn(fields, field)) return respond('Opção indisponível.');
      if (field.startsWith('product_') && !snapshot.shop.products.some((p) => p.id === productId))
        return respond('Produto indisponível.');
      draft = {
        ownerId: snapshot.ownerId!,
        generation: snapshot.generation,
        revision: snapshot.revision,
        field,
        ...(field.startsWith('product_') ? { productId } : {}),
      };
      await this.save(draft);
      const hint = field.includes('banner')
        ? 'Envie uma foto ou um link HTTPS. Para retirar, envie remover.'
        : field === 'product_price'
          ? snapshot.shop.payment_mode === 'manual'
            ? 'Envie o novo preço em reais. Exemplo: 16,00.'
            : 'Envie o novo preço inteiro em Stars.'
          : field === 'support'
            ? 'Envie o @usuario do suporte. Para retirar, envie remover.'
            : field === 'support_url'
              ? 'Envie um link HTTPS. Para retirar, envie remover.'
              : `Envie ${field === 'welcome' ? 'a nova mensagem de boas-vindas' : 'o novo conteúdo'}.`;
      return respond(fields[field] + '\n\n' + hint, [[['Cancelar alteração', 'lc:cancel']]]);
    }
    if (cmd === 'lc:save') {
      if (!draft?.command)
        return respond('Não há alteração pendente. Escolha uma opção para editar.');
      try {
        const result = await this.commit(draft.command);
        this.install(result.snapshot);
        await this.save(null);
        return respond('✓ Alteração salva na loja.');
      } catch {
        // Keep the SAME mutation ID after an ambiguous response. A retry cannot
        // apply twice or overwrite a newer edit using a newly generated key.
        return respond(
          'Não foi possível confirmar o salvamento.\n\nO rascunho foi preservado. Tente novamente; se a loja mudou, descarte e atualize antes de refazer.',
          [[['Tentar salvar novamente', 'lc:save']], [['Descartar rascunho', 'lc:cancel']]],
        );
      }
    }
    if (draft && msg && !text.startsWith('/')) {
      if (draft.command)
        return respond(
          'Você já tem uma alteração preparada. Salve ou descarte antes de enviar outro conteúdo.',
          [[['Salvar alteração', 'lc:save']], [['Descartar', 'lc:cancel']]],
        );
      let value: unknown = text.toLowerCase() === 'remover' ? '' : text;
      if (draft.field.includes('banner')) value = msg.photo?.at(-1)?.file_id ?? value;
      if (draft.field === 'product_price')
        value = parsePrice(text, snapshot.shop.payment_mode === 'manual');
      const parsed = shopConfigurationChange.safeParse({
        kind: draft.field,
        ...(draft.productId ? { productId: draft.productId } : {}),
        value,
      });
      if (!parsed.success)
        return respond(
          'Conteúdo inválido para ' +
            fields[draft.field].toLowerCase() +
            '. Confira o formato e envie novamente.',
          [[['Cancelar', 'lc:cancel']]],
        );
      draft.command = {
        mutationId: randomUUID(),
        ownerId: draft.ownerId,
        generation: draft.generation,
        revision: draft.revision,
        change: parsed.data,
      };
      await this.save(draft);
      const preview = draft.field.includes('banner')
        ? value
          ? 'Foto selecionada'
          : 'Sem banner'
        : draft.field === 'product_price'
          ? money(Number(value), snapshot.shop.payment_mode === 'manual' ? 'BRL' : 'XTR')
          : String(value || 'Removido');
      return respond(
        'Conferir alteração\n' +
          fields[draft.field] +
          '\n\n' +
          preview +
          '\n\nToque em Salvar para aplicar na loja.',
        [[['Salvar alteração', 'lc:save']], [['Descartar rascunho', 'lc:cancel']]],
      );
    }
    if (draft && (cb || text.startsWith('/'))) await this.save(null);
    return null;
  }
}
