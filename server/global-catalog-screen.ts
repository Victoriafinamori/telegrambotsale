import { tokenHash } from './accounts.js';
import { money } from './bot-appearance.js';
import { botButtons } from './bot-data.js';
import type { Product, Shop } from './bot-types.js';

type Offer = { supplierId: string; product: Product; baseCents: number };
const short = (s: string) => (s.length > 38 ? s.slice(0, 37) + '…' : s);
export function globalCatalogScreen(offers: Offer[], shop: Shop, action: string) {
  const categories = [...new Set(offers.map((o) => o.product.category))].sort();
  const parts = action.split(':');
  const category =
    parts[0] === 'globalcat'
      ? categories.find((c) => tokenHash(c).slice(0, 16) === parts[1])
      : undefined;
  const categoryPage = parts[0] === 'globalcategories';
  if (categoryPage || (parts[0] === 'globalcat' && !category)) {
    const page = Math.min(
      Math.max(0, Math.floor(Number(parts[1]) || 0)),
      Math.max(0, Math.ceil(categories.length / 8) - 1),
    );
    return {
      text: offers.length
        ? `📦 Estoque global\nEscolha uma categoria\n\nEscolha um produto e defina seu preço de venda. O estoque e a entrega ficam com a Blackout.\n\n${offers.length} produtos · ${categories.length} categorias\nPágina ${page + 1} de ${Math.ceil(categories.length / 8)}`
        : '📦 CATÁLOGO INDISPONÍVEL\n\nNenhum produto foi liberado para sua loja. Atualize o catálogo; se continuar vazio, peça à Blackout para conferir sua autorização.',
      markup: botButtons([
        ...categories
          .slice(page * 8, page * 8 + 8)
          .map(
            (c) =>
              [
                [
                  `${short(c)} · ${offers.filter((o) => o.product.category === c).length}`,
                  'admin:globalcat:' + tokenHash(c).slice(0, 16) + ':0',
                ],
              ] as [string, string][],
          ),
        ...(page > 0
          ? [[['‹ Anterior', 'admin:globalcategories:' + (page - 1)]] as [string, string][]]
          : []),
        ...(categories.length > (page + 1) * 8
          ? [[['Próxima ›', 'admin:globalcategories:' + (page + 1)]] as [string, string][]]
          : []),
        [['↻ Atualizar catálogo', 'admin:globalcategories:' + page]],
        [['‹ Administração', 'admin']],
      ]),
    };
  }
  const list = category ? offers.filter((o) => o.product.category === category) : offers;
  const page = Math.min(
    Math.max(0, Math.floor(Number(category ? parts[2] : parts[1]) || 0)),
    Math.max(0, Math.ceil(list.length / 8) - 1),
  );
  const target = category
    ? 'admin:globalcat:' + tokenHash(category).slice(0, 16) + ':'
    : 'admin:globalproducts:';
  return {
    text: list.length
      ? `📦 ${category ?? 'Estoque global Blackout'}\nEscolha um produto\n\nOs valores abaixo são o custo do fornecedor. Você define o preço de revenda na próxima tela.\n✓ Já está na sua loja · toque para ajustar o preço\n\nPágina ${page + 1} de ${Math.ceil(list.length / 8)}`
      : '📦 CATÁLOGO INDISPONÍVEL\n\nAtualize o catálogo ou peça à Blackout para conferir sua autorização.',
    markup: botButtons([
      ...list
        .slice(page * 8, page * 8 + 8)
        .map(
          (o) =>
            [
              [
                `${shop.products.some((p) => p.resale_source?.supplierId === o.supplierId && p.resale_source.productId === o.product.id) ? '✓ ' : ''}${short(o.product.title)} · ${money(o.baseCents, 'BRL')}`,
                'admin:globalpick:' + o.product.id,
              ],
            ] as [string, string][],
        ),
      ...(page > 0 ? [[['‹ Anterior', target + (page - 1)]] as [string, string][]] : []),
      ...(list.length > (page + 1) * 8
        ? [[['Próxima ›', target + (page + 1)]] as [string, string][]]
        : []),
      [['↻ Atualizar catálogo', target + page]],
      [['‹ Categorias', 'admin:globalcategories:0']],
      [['Cancelar', 'admin']],
    ]),
  };
}
