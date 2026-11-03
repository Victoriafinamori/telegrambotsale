import type { Shop } from './bot-types.js';
import { botButtons } from './bot-data.js';
import { tokenHash } from './token-hash.js';

// Supplier catalog metadata only. Delivery units never enter the category screen.
export function supplierStockScreen(shop: Shop, action: string) {
  const products = shop.products.filter((p) => !p.resale_source);
  const categories = [...new Set(products.map((p) => p.category))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
  const parts = action.split(':'),
    category =
      parts[0] === 'suppliercat'
        ? categories.find((c) => tokenHash(c).slice(0, 16) === parts[1])
        : undefined;
  const all = parts[0] === 'supplierlow';
  const finite = (p: (typeof products)[number]) => p.enabled && p.stock_mode !== 'infinite';
  const urgent = products.filter((p) => finite(p) && p.stock <= 5);
  const short = (v: string) => (v.length > 32 ? v.slice(0, 31) + '…' : v);
  if (action === 'supplier' || parts[0] === 'suppliercategories') {
    const page = Math.min(
      Math.max(0, Math.floor(Number(parts[1]) || 0)),
      Math.max(0, Math.ceil(categories.length / 8) - 1),
    );
    return {
      text:
        '📦 Seu estoque global\n\n' +
        products.length +
        ' produtos · ' +
        categories.length +
        ' categorias\n' +
        urgent.filter((p) => p.stock <= 0).length +
        ' sem estoque · ' +
        urgent.filter((p) => p.stock > 0).length +
        ' com até 5 unidades\n\n' +
        'A reposição aqui abastece os revendedores autorizados. Cada venda reserva uma unidade deste mesmo estoque.',
      markup: botButtons([
        ...(urgent.length
          ? [[['Repor primeiro · ' + urgent.length, 'admin:supplierlow:0']] as [string, string][]]
          : []),
        ...categories
          .slice(page * 8, page * 8 + 8)
          .map(
            (c) =>
              [[short(c), 'admin:suppliercat:' + tokenHash(c).slice(0, 16) + ':0']] as [
                string,
                string,
              ][],
          ),
        ...(page > 0
          ? [[['‹ Anterior', 'admin:suppliercategories:' + (page - 1)]] as [string, string][]]
          : []),
        ...(categories.length > (page + 1) * 8
          ? [[['Próxima ›', 'admin:suppliercategories:' + (page + 1)]] as [string, string][]]
          : []),
        [['＋ Criar produto de fornecedor', 'admin:newown']],
        [['‹ Administração', 'admin']],
      ]),
    };
  }
  const selected = (all ? urgent : products.filter((p) => p.category === category)).sort((a, b) => {
    const priority = (p: typeof a) => (finite(p) ? (p.stock <= 0 ? 0 : p.stock <= 5 ? 1 : 2) : 3);
    return (
      priority(a) - priority(b) || a.stock - b.stock || a.title.localeCompare(b.title, 'pt-BR')
    );
  });
  const page = Math.min(
    Math.max(0, Math.floor(Number(parts[all ? 1 : 2]) || 0)),
    Math.max(0, Math.ceil(selected.length / 8) - 1),
  );
  const route = all ? 'admin:supplierlow:' : 'admin:suppliercat:' + parts[1] + ':';
  return {
    text:
      (all ? 'Reposição prioritária' : (category ?? 'Categoria indisponível')) +
      '\n\n' +
      (selected.length
        ? 'Toque em um produto para ver as unidades e repor. Os itens sem estoque aparecem primeiro.'
        : 'Nenhum produto nesta seleção.'),
    markup: botButtons([
      ...selected
        .slice(page * 8, page * 8 + 8)
        .map(
          (p) =>
            [
              [
                short(p.title) + ' · ' + (p.stock_mode === 'infinite' ? '∞' : p.stock),
                'admin:stockfor:' + p.id,
              ],
            ] as [string, string][],
        ),
      ...(page > 0 ? [[['‹ Anterior', route + (page - 1)]] as [string, string][]] : []),
      ...(selected.length > (page + 1) * 8
        ? [[['Próxima ›', route + (page + 1)]] as [string, string][]]
        : []),
      [['‹ Estoque global', 'admin:supplier']],
    ]),
  };
}
