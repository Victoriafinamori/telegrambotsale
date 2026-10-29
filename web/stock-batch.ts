import type { StockProduct } from './stock-priority.js';
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function mountStockBatch(
  host: HTMLElement,
  products: StockProduct[],
  save: (ids: string[], units: string[], requestId: string) => Promise<void>,
) {
  const selected = new Set<string>();
  const eligible = (p: StockProduct) =>
    !p.resale_source && (!p.stock_mode || p.stock_mode === 'individual');
  host
    .querySelector('[data-stock-results]')!
    .insertAdjacentHTML(
      'beforebegin',
      '<div class="stock-batch-bar"><div><strong data-stock-selection>0 produtos selecionados</strong><small>Copie o mesmo conteúdo para estoques individuais.</small></div><div class="stock-batch-actions"><button type="button" class="quiet" data-select-visible>Selecionar visíveis</button><button type="button" class="quiet" data-clear-selection disabled>Limpar seleção</button><button type="button" data-batch-open disabled>Repor selecionados</button></div></div>',
    );
  const sync = () => {
    if (!host.isConnected) return;
    host.querySelector('[data-stock-selection]')!.textContent =
      `${selected.size} ${selected.size === 1 ? 'produto selecionado' : 'produtos selecionados'}`;
    host
      .querySelectorAll<HTMLButtonElement>('[data-clear-selection],[data-batch-open]')
      .forEach((b) => (b.disabled = !selected.size));
    host
      .querySelectorAll<HTMLInputElement>('[data-stock-select]')
      .forEach((input) => (input.checked = selected.has(input.value)));
  };
  const open = () => {
    const targets = products.filter((p) => selected.has(p.id));
    if (!targets.length) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'stock-batch-dialog';
    dialog.setAttribute('aria-label', 'Reposição em lote');
    dialog.innerHTML = `<div class="stock-group-heading"><h2>Repor ${targets.length} estoques</h2><button type="button" class="quiet" data-close>Fechar</button></div><p>Cada linha será adicionada a <strong>todos os produtos abaixo</strong>. Cada estoque terá sua própria cópia; as vendas descontam separadamente.</p><ul>${targets.map((p) => `<li>${esc(p.title)} <small>· ${esc(p.category)}</small></li>`).join('')}</ul><form><label>Conteúdo para todos os selecionados<textarea name="units" rows="6" maxlength="20020" required placeholder="Uma unidade por linha" autofocus></textarea></label><p data-summary>Até 20 unidades por produto neste envio · limite de 100 disponíveis por produto.</p><p role="alert" data-error></p><div class="stock-batch-actions"><button type="button" class="quiet" data-close>Cancelar</button><button type="submit">Adicionar aos ${targets.length} estoques</button></div></form>`;
    document.body.append(dialog);
    dialog
      .querySelectorAll('[data-close]')
      .forEach((b) => b.addEventListener('click', () => dialog.close()));
    const form = dialog.querySelector('form')!,
      input = form.querySelector('textarea')!,
      button = form.querySelector<HTMLButtonElement>('[type=submit]')!,
      requestId = crypto.randomUUID();
    input.addEventListener('input', () => {
      const n = input.value.split('\n').filter((v) => v.trim()).length;
      form.querySelector('[data-summary]')!.textContent =
        `${n} unidades por produto × ${targets.length} produtos = ${n * targets.length} cópias. Até 20 unidades por produto neste envio.`;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const units = input.value
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean),
        error = form.querySelector('[data-error]')!;
      if (!units.length || units.length > 20 || units.some((u) => u.length > 1000)) {
        error.textContent = 'Informe de 1 a 20 unidades, com até 1.000 caracteres por linha.';
        return;
      }
      button.disabled = true;
      input.readOnly = true;
      error.textContent = '';
      try {
        await save(
          targets.map((p) => p.id),
          units,
          requestId,
        );
        selected.clear();
        dialog.close();
        sync();
      } catch (e) {
        error.textContent =
          (e instanceof Error ? e.message : 'Não foi possível repor os estoques.') +
          ' Tente novamente para conferir o mesmo envio.';
        button.disabled = false;
      }
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
  };
  host.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-stock-select]')) return;
    e.stopPropagation();
    input.checked ? selected.add(input.value) : selected.delete(input.value);
    sync();
  });
  host.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('button');
    if (!b) return;
    if (b.hasAttribute('data-select-visible')) {
      e.stopPropagation();
      host
        .querySelectorAll<HTMLInputElement>('[data-stock-select]:not(:disabled)')
        .forEach((i) => selected.add(i.value));
      sync();
    } else if (b.hasAttribute('data-clear-selection')) {
      e.stopPropagation();
      selected.clear();
      sync();
    } else if (b.hasAttribute('data-batch-open')) {
      e.stopPropagation();
      open();
    }
  });
  return () => {
    host.querySelectorAll<HTMLElement>('[data-stock-id]').forEach((row) => {
      const p = products.find((p) => p.id === row.dataset.stockId)!;
      row.classList.add('stock-item-selectable');
      row.insertAdjacentHTML(
        'afterbegin',
        `<label class="stock-select" title="${eligible(p) ? 'Selecionar para reposição em lote' : 'Reposição em lote disponível para estoque individual próprio'}"><input type="checkbox" data-stock-select value="${esc(p.id)}" aria-label="Selecionar ${esc(p.title)}" ${eligible(p) ? '' : 'disabled'}></label>`,
      );
    });
    sync();
  };
}
