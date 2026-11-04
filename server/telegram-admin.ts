import type { Shop } from './bot-types.js';
import { hasSupport } from './bot-appearance.js';
import { botButtons as buttons } from './bot-data.js';

export function telegramSetup(shop: Shop) {
  const categories = new Set([...(shop.categories ?? []), ...shop.products.map((p) => p.category)]);
  const steps = [
    {
      title: 'Boas-vindas e banner',
      done: Boolean(
        shop.telegram_setup?.welcome ||
          (shop.welcome.trim() && shop.welcome !== 'Escolha um produto para começar.'),
      ),
      action: 'admin:setup:0',
    },
    { title: 'Suporte', done: hasSupport(shop), action: 'admin:setup:1' },
    { title: 'Categorias', done: categories.size > 0, action: 'admin:setup:2' },
    {
      title: 'Produtos e estoque',
      done: shop.products.some((p) => p.enabled && (p.stock_mode === 'infinite' || p.stock > 0)),
      action: 'admin:setup:3',
    },
    {
      title: 'Pagamento',
      done:
        shop.payment_mode === 'stars' ||
        Boolean(
          shop.payment_mode === 'manual' &&
            (shop.payment_instructions ||
              shop.pix_keys?.length ||
              shop.mp_connection ||
              (shop.purin_connection && shop.purin_subaccount)),
        ),
      action: 'admin:setup:4',
    },
  ];
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    next: steps.find((s) => !s.done)?.action ?? 'admin:preview',
  };
}

export function adminHome(shop: Shop, managesGlobal = false) {
  const progress = telegramSetup(shop);
  return {
    text: `🏪 ${shop.title}\nAdministração da loja\n\n${progress.completed === progress.steps.length ? 'Configuração básica preenchida. Confira a prévia antes de divulgar.' : `Preparação: ${progress.completed} de ${progress.steps.length} etapas preenchidas.\nContinue de onde parou ou abra uma área abaixo.`}\n\nAs alterações são salvas na sua loja. O banner é opcional.`,
    markup: buttons([
      [
        [
          shop.telegram_setup?.dismissed
            ? '⚙️ Configurar loja'
            : progress.completed === progress.steps.length
              ? '⚙️ Revisar configuração'
              : '✨ Continuar configuração',
          'admin:setup',
        ],
      ],
      [['👁 Ver como cliente', 'admin:preview']],
      ...(managesGlobal
        ? [[['📦 Meu estoque global', 'admin:supplier']] as [string, string][]]
        : []),
      [
        ['🏪 Aparência e suporte', 'admin:store'],
        ['📦 Catálogo e estoque', 'admin:catalogue'],
      ],
      [
        ['🧾 Vendas e clientes', 'admin:sales'],
        ['💰 Financeiro', 'admin:finance'],
      ],
      [
        ['🤝 Revenda integrada', 'admin:resale'],
        ['📣 Avisos', 'admin:notices'],
      ],
    ]),
  };
}
