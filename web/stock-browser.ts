import { mountStockBatch } from './stock-batch.js';
import './stock-browser.css';
import {
  stockPriority,
  stockView,
  type StockProduct,
  type StockFilters,
} from './stock-priority.js';
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function mountStockBrowser(
  host: HTMLElement,
  products: StockProduct[],
  state: StockFilters,
  open: (id: string) => void,
  batch?: (ids: string[], units: string[], requestId: string) => Promise<void>,
) {
  const categories = [...new Set(products.map((p) => p.category))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
  host.classList.add('stock-browser');
  host.innerHTML = `<div class="stock-toolbar"><label>Buscar produto<input type="search" data-stock-search placeholder="Nome do produto ou categoria" value="${esc(state.query)}"></label><label>Categoria<select data-stock-category><option value="">Todas as categorias</option>${categories.map((c) => `<option value="${esc(c)}" ${state.category === c ? 'selected' : ''}>${esc(c || 'Sem categoria')}</option>`).join('')}</select></label><label>Disponibilidade<select data-stock-availability><option value="all">Todos os produtos</option><option value="low">Precisam de reposição · até 5</option><option value="empty">Sem estoque</option></select></label></div><p class="stock-result" role="status" data-stock-result></p><div data-stock-results></div>`;
  const refreshSelection = batch ? mountStockBatch(host, products, batch) : undefined;
  const availability = host.querySelector<HTMLSelectElement>('[data-stock-availability]')!;
  availability.value = state.availability;
  const row = (p: StockProduct) => {
    const priority = stockPriority(p),
      infinite = p.stock_mode === 'infinite';
    const status =
      p.enabled === false
        ? 'Produto oculto'
        : infinite
          ? 'Infinito'
          : priority === 0
            ? 'Sem estoque'
            : priority === 1
              ? 'Estoque baixo'
              : 'Disponível';
    return `<div class="stock-item" data-stock-id="${esc(p.id)}"><div class="stock-item-name"><strong>${esc(p.title)}</strong><small>${esc(p.category || 'Sem categoria')} · ${p.stock_mode === 'ghost' ? 'Entrega fantasma' : infinite ? 'Entrega contínua' : 'Unidades individuais'}${p.resale_source ? ' · Estoque do fornecedor' : ''}</small></div><div class="stock-item-balance"><b>${infinite ? '∞' : Math.max(0, p.stock).toLocaleString('pt-BR')}</b><span>disponíveis</span></div><span class="stock-status" data-priority="${priority}">${status}</span><button type="button" class="${priority < 2 ? '' : 'quiet'}" data-stock-open="${esc(p.id)}" aria-label="${priority < 2 ? 'Repor' : 'Gerenciar'} estoque de ${esc(p.title)}">${priority < 2 && !p.resale_source ? 'Repor estoque' : 'Gerenciar'}</button></div>`;
  };
  const draw = () => {
    const view = stockView(products, state);
    host.querySelector('[data-stock-result]')!.textContent =
      `${view.count} ${view.count === 1 ? 'produto encontrado' : 'produtos encontrados'} · ${view.urgent.length} para repor. Alertas consideram produtos ativos com até 5 unidades.`;
    host.querySelector('[data-stock-results]')!.innerHTML =
      `${view.urgent.length ? `<section class="stock-group stock-urgent"><div class="stock-group-heading"><h3>Repor primeiro</h3><span>${view.urgent.length} produtos</span></div>${view.urgent.map(row).join('')}</section>` : ''}${view.groups.map((g) => `<section class="stock-group"><div class="stock-group-heading"><h3>${esc(g.category || 'Sem categoria')}</h3><span>${g.products.length} ${g.products.length === 1 ? 'produto' : 'produtos'}</span></div>${g.products.map(row).join('')}</section>`).join('')}${!view.count ? '<div class="stock-empty"><h3>Nenhum produto encontrado</h3><p>Altere a busca ou os filtros para ver outros produtos.</p></div>' : ''}`;
    refreshSelection?.();
  };
  host.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.matches('[data-stock-search]')) {
      state.query = target.value;
      draw();
    }
  });
  host.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    if (target.matches('[data-stock-category]')) state.category = target.value;
    else if (target.matches('[data-stock-availability]')) state.availability = target.value;
    else return;
    draw();
  });
  host.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-stock-open]');
    if (b) {
      e.stopPropagation();
      open(b.dataset.stockOpen!);
    }
  });
  draw();
}
