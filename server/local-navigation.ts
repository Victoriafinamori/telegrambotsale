import type { BotEffect, Product, Shop, TelegramUpdate } from './bot-types.js';
import { tokenHash } from './accounts.js';
import { money, productText, supportDetails } from './bot-appearance.js';
import { reuseNavigationMessage } from './bot-navigation.js';

export interface NavigationSnapshot {
  accountId: string;
  expiresAt: number;
  ownerId: string | null;
  ownerVerified?: boolean;
  revision?: string;
  generation?: string;
  ownerHasCentralSession?: boolean;
  shop: Pick<
    Shop,
    | 'title'
    | 'welcome'
    | 'banner'
    | 'support'
    | 'support_name'
    | 'support_phone'
    | 'support_url'
    | 'payment_mode'
    | 'category_emojis'
  > & { products: Product[] };
}

// Display only. No cart, orders, sessions, credentials, stock units or money moves.
export function localNavigation(
  snapshot: NavigationSnapshot,
  update: TelegramUpdate,
  now = Date.now(),
  localConfiguration = false,
): BotEffect[] | null {
  const cb = update.callback_query,
    start =
      update.message?.text === '/start' &&
      !update.message.successful_payment &&
      !update.message.refunded_payment &&
      !update.pre_checkout_query,
    message = cb?.message ?? (start ? update.message : undefined),
    from = cb?.from ?? (start ? update.message?.from : undefined),
    owner = String(from?.id) === snapshot.ownerId && snapshot.ownerVerified === true;
  if (
    (!cb && !start) ||
    !from ||
    !message ||
    message.chat.type !== 'private' ||
    message.chat.id !== from.id ||
    from.is_bot ||
    (owner && snapshot.ownerHasCentralSession) ||
    (String(from.id) === snapshot.ownerId && !owner) ||
    snapshot.expiresAt <= now ||
    !/^(home|catalog|support|cat:[a-f0-9]{16}|p:[a-f0-9]{12,36})$/.test(
      start ? 'home' : (cb?.data ?? ''),
    )
  )
    return null;
  const shop = snapshot.shop,
    cmd = start ? 'home' : cb!.data!;
  const rows = (buttons: [string, string][][]) => ({
    inline_keyboard: buttons.map((row) =>
      row.map(([text, callback_data]) => ({ text, callback_data })),
    ),
  });
  const menu = () =>
    rows([
      [
        ['🛍️ Produtos', 'catalog'],
        ['🛒 Carrinho', 'cart'],
      ],
      [
        ['🧾 Meus pedidos', 'orders'],
        ['💬 Suporte', 'support'],
      ],
      ...(owner
        ? [
            [
              ['⚙️ Gerenciar loja', 'admin'],
              ['Carteira', 'admin:wallet'],
            ] as [string, string][],
          ]
        : []),
      ...(owner && localConfiguration
        ? [[['Personalizar loja', 'lc:menu']] as [string, string][]]
        : []),
    ]);
  let text = '',
    photo = '',
    markup: unknown = menu();
  if (cmd === 'home') {
    text = shop.title + '\n\n' + shop.welcome;
    photo = shop.banner;
  } else if (cmd === 'support') text = supportDetails(shop as Shop).text;
  else if (cmd.startsWith('p:')) {
    const p = shop.products.find((p) => p.enabled && p.id === cmd.slice(2));
    if (!p) text = 'Produto indisponível.';
    else {
      text = productText(p, shop as Shop);
      photo = p.banner ?? '';
      markup = rows(
        p.stock > 0
          ? [
              [
                ['Comprar agora', 'buy:' + p.id],
                ['Adicionar ao carrinho', 'add:' + p.id],
              ],
              [
                ['‹ Categoria', 'cat:' + tokenHash(p.category).slice(0, 16)],
                ['Carrinho', 'cart'],
              ],
            ]
          : [
              [['Avisar quando voltar', 'watch-on:' + p.id]],
              [['Não, voltar', 'cat:' + tokenHash(p.category).slice(0, 16)]],
            ],
      );
    }
  } else {
    const categories = [
      ...new Set(shop.products.filter((p) => p.enabled).map((p) => p.category)),
    ].sort();
    const category = categories.find((c) => 'cat:' + tokenHash(c).slice(0, 16) === cmd);
    if (!category) {
      text = shop.title + '\n\nEscolha uma categoria para ver os produtos.';
      markup = rows([
        ...categories.map(
          (c) =>
            [
              [
                `${shop.category_emojis?.[c] ? shop.category_emojis[c] + ' ' : ''}${c}`,
                'cat:' + tokenHash(c).slice(0, 16),
              ],
            ] as [string, string][],
        ),
        [
          ['🛒 Carrinho', 'cart'],
          ['🏠 Início', 'home'],
        ],
      ]);
    } else {
      text = category + '\n\nEscolha um produto para ver os detalhes.';
      markup = rows([
        ...shop.products
          .filter((p) => p.enabled && p.category === category)
          .map(
            (p) =>
              [
                [
                  p.title + ' · ' + money(p.price, shop.payment_mode === 'manual' ? 'BRL' : 'XTR'),
                  'p:' + p.id,
                ],
              ] as [string, string][],
          ),
        [
          ['‹ Categorias', 'catalog'],
          ['🛒 Carrinho', 'cart'],
        ],
      ]);
    }
  }
  const effects: BotEffect[] = [
    ...(cb
      ? [
          {
            id: 'local_ack_' + update.update_id,
            method: 'answerCallbackQuery',
            status: 'pending',
            payload: { callback_query_id: cb.id },
          } as BotEffect,
        ]
      : []),
    {
      id: 'local_screen_' + update.update_id,
      method: photo ? 'sendPhoto' : 'sendMessage',
      status: 'pending',
      payload: {
        chat_id: message.chat.id,
        ...(photo ? { photo, caption: text } : { text }),
        reply_markup: markup,
      },
    },
  ];
  // Oversized media captions must use the existing central renderer.
  if (photo && text.length > 1024) return null;
  reuseNavigationMessage(update, effects);
  return effects;
}
