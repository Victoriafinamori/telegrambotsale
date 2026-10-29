export type StockProduct = {
  id: string;
  title: string;
  category: string;
  stock: number;
  stock_mode?: string;
  enabled?: boolean;
  resale_source?: unknown;
};
export type StockFilters = { query: string; category: string; availability: string };
export const lowStockLimit = 5;
export function stockPriority(p: StockProduct) {
  if (p.enabled === false || p.stock_mode === 'infinite') return 3;
  return p.stock <= 0 ? 0 : p.stock <= lowStockLimit ? 1 : 2;
}
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
export function stockView(products: StockProduct[], filters: StockFilters) {
  const rows = products.filter(
    (p) =>
      (!filters.category || p.category === filters.category) &&
      (!filters.query ||
        normalize(p.title + ' ' + p.category).includes(normalize(filters.query.trim()))) &&
      (filters.availability === 'empty'
        ? stockPriority(p) === 0
        : filters.availability === 'low'
          ? stockPriority(p) < 2
          : true),
  );
  const sort = (a: StockProduct, b: StockProduct) =>
    stockPriority(a) - stockPriority(b) ||
    a.stock - b.stock ||
    a.title.localeCompare(b.title, 'pt-BR');
  const urgent = rows.filter((p) => stockPriority(p) < 2).sort(sort);
  const rest = rows.filter((p) => stockPriority(p) >= 2);
  const categories = [...new Set(rest.map((p) => p.category))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
  return {
    urgent,
    groups: categories.map((category) => ({
      category,
      products: rest.filter((p) => p.category === category).sort(sort),
    })),
    count: rows.length,
  };
}
