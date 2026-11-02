import type { Product } from '../server/bot-types.js';
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function bundleEditor(products: Product[], current?: Product, createBundle = false) {
  if (current?.resale_source) return '';
  const candidates = products.filter(
    (p) => p.id !== current?.id && !p.bundle?.length && !p.resale_source,
  );
  return `<section class="mc-bundle-editor"><label>Como este produto é entregue?<select name="productKind" data-bundle-type><option value="individual">Produto individual · estoque próprio</option><option value="bundle" ${current?.bundle?.length || createBundle ? 'selected' : ''}>Combo automático · usa outros produtos</option></select></label><div data-bundle-parts ${current?.bundle?.length || createBundle ? '' : 'hidden'}><h3>O que entra em uma compra deste combo?</h3><p>Selecione de 2 a 8 produtos e a quantidade de cada um. Abasteça somente os produtos individuais; o saldo do combo é automático.</p><div class="mc-bundle-rows">${
    candidates
      .map((p) => {
        const row = current?.bundle?.find((r) => r.productId === p.id);
        return `<div class="mc-bundle-row"><label><input type="checkbox" name="bundleProduct" value="${p.id}" ${row ? 'checked' : ''}><span><b>${esc(p.title)}</b><small>${esc(p.category)} · ${p.stock_mode === 'infinite' ? 'Sem limite' : p.stock + ' disponíveis'}</small></span></label><label>Quantidade<input name="bundleQty_${p.id}" type="number" min="1" max="10" step="1" value="${row?.quantity ?? 1}" ${row ? '' : 'disabled'}></label></div>`;
      })
      .join('') || '<p>Cadastre primeiro pelo menos dois produtos individuais.</p>'
  }</div><p role="status" data-bundle-summary></p><small>O preço do combo é definido por você. Os componentes são entregues juntos após a confirmação do pagamento.</small></div></section>`;
}
export function updateBundleEditor(host: HTMLElement, products: Product[]) {
  const form = host.querySelector<HTMLFormElement>('form[data-form="product"]');
  if (!form) return;
  const kind = form.querySelector<HTMLSelectElement>('[data-bundle-type]'),
    parts = form.querySelector<HTMLElement>('[data-bundle-parts]');
  if (!kind || !parts) return;
  parts.hidden = kind.value !== 'bundle';
  const rows = [...form.querySelectorAll<HTMLInputElement>('[name="bundleProduct"]')];
  let available = 1000000,
    count = 0,
    units = 0;
  for (const row of rows) {
    const qty = form.elements.namedItem('bundleQty_' + row.value) as HTMLInputElement;
    qty.disabled = !row.checked || kind.value !== 'bundle';
    if (row.checked) {
      count++;
      const n = Number(qty.value);
      units += n;
      const p = products.find((p) => p.id === row.value);
      available = Math.min(available, p?.enabled && n > 0 ? Math.floor(p.stock / n) : 0);
    }
  }
  parts.querySelector('[data-bundle-summary]')!.textContent =
    count < 2
      ? 'Escolha pelo menos 2 produtos para montar o combo.'
      : count > 8 || units > 20
        ? 'Use até 8 produtos diferentes e 20 unidades no total.'
        : `Este combo terá ${available.toLocaleString('pt-BR')} unidades disponíveis, conforme o estoque dos componentes.`;
  kind.setCustomValidity(
    kind.value === 'bundle' && (count < 2 || count > 8 || units > 20)
      ? 'Selecione de 2 a 8 produtos, com até 20 unidades no total.'
      : '',
  );
}
export function bundleInventory(
  dialog: HTMLDialogElement,
  p: Product,
  products: Product[],
  open: (id: string) => void,
) {
  dialog.innerHTML = `<div class="mc-panel-head"><div><h2>${esc(p.title)}</h2><p>Combo automático · ${p.stock} disponíveis</p></div><button type="button" data-close>Fechar</button></div><p>Este combo não tem estoque separado. Reponha os produtos abaixo e o saldo será atualizado automaticamente.</p><div class="mc-bundle-rows">${(
    p.bundle ?? []
  )
    .map((r) => {
      const component = products.find((v) => v.id === r.productId);
      return `<div class="mc-bundle-row"><div><b>${r.quantity} × ${esc(component?.title ?? 'Produto removido')}</b><small>${component?.stock ?? 0} disponíveis no produto individual</small></div><button type="button" data-bundle-stock="${r.productId}">Repor componente</button></div>`;
    })
    .join('')}</div>`;
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  dialog.querySelectorAll<HTMLButtonElement>('[data-bundle-stock]').forEach((b) =>
    b.addEventListener('click', () => {
      dialog.close();
      open(b.dataset.bundleStock!);
    }),
  );
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
