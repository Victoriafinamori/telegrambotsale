import './resale.css';
type Api = <T = any>(path: string, body?: unknown) => Promise<T>;
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const labels: Record<string, string> = {
  none: 'Não participa',
  requested: 'Solicitação pendente',
  approved: 'Aprovado',
  revoked: 'Revogado',
};
const kinds = [
  ['products', 'Revender produtos', 'Ofereça produtos do estoque global em sua loja.'],
  ['plans', 'Revender planos Blackout', 'Defina seu preço para oferecer lojas Blackout.'],
] as const;
const title = (admin: boolean) =>
  `<div class="rs-heading"><div><span class="rs-eyebrow">${admin ? 'CENTRAL DA DONA' : 'CRESÇA COM A BLACKOUT'}</span><h1>${admin ? 'Estoque global e parceiros' : 'Opções de revenda'}</h1><p>${admin ? 'Seu catálogo central, suas autorizações e seus parceiros em um só lugar.' : 'Sua loja funciona por conta própria. A revenda é opcional e você escolhe como participar.'}</p></div><a class="button-link quiet" href="${admin ? '#/conta' : '#/minha-loja'}">Voltar ao painel</a></div>`;
export async function mountResale(host: HTMLElement, api: Api, admin = false) {
  let data: any,
    own: any,
    offers: any,
    plans: any,
    filter = 'all';
  const feedback = (message: string) => {
    const node = host.querySelector('[data-resale-feedback]');
    if (node) node.textContent = message;
  };
  const refresh = async () => {
    if (admin) data = await api('/admin/resale');
    else
      [own, offers, plans] = await Promise.all([
        api('/store/resale'),
        api('/store/resale/products'),
        api('/store/resale/plans'),
      ]);
    render();
  };
  const run = async (action: () => Promise<void>) => {
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')].map((b) => ({
      b,
      disabled: b.disabled,
    }));
    buttons.forEach(({ b }) => (b.disabled = true));
    try {
      await action();
    } catch (error) {
      feedback(error instanceof Error ? error.message : 'Não foi possível concluir.');
    } finally {
      buttons.forEach(({ b, disabled }) => (b.disabled = disabled));
    }
  };
  const render = () => {
    host.innerHTML =
      title(admin) +
      '<p role="status" data-resale-feedback></p>' +
      (admin ? renderAdmin() : renderMerchant());
    const selector = host.querySelector<HTMLSelectElement>('[data-filter]');
    if (selector) selector.value = filter;
  };
  const renderMerchant = () =>
    `<div class="rs-grid">${kinds.map(([key, label, description]) => `<section class="rs-card"><span class="rs-icon">${key === 'products' ? '↗' : 'B'}</span><span class="rs-badge" data-status="${own.permissions[key]}">${esc(labels[own.permissions[key]])}</span><h2>${label}</h2><p>${description}</p><p class="rs-muted">${key === 'products' ? 'Você recebe acesso somente aos produtos liberados pela dona.' : 'A Blackout recebe o valor base; a tarifa Purin sai da sua margem. Sem comissão adicional de 12% nos planos.'}</p><button class="${own.permissions[key] === 'none' || own.permissions[key] === 'revoked' ? '' : 'quiet'}" data-opt="${key}" data-enable="${own.permissions[key] === 'none' || own.permissions[key] === 'revoked'}">${own.permissions[key] === 'none' || own.permissions[key] === 'revoked' ? 'Quero participar' : 'Desativar participação'}</button></section>`).join('')}</div>${own.permissions.products === 'approved' ? `<section class="rs-card"><h2>Catálogo liberado para você</h2><div class="rs-catalog">${offers.products.map((p: any) => `<article><span class="rs-badge">${p.stockMode === 'infinite' ? 'Sem limite' : p.stock + ' disponíveis'}</span><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p><b>Fornecedor: ${money(p.baseCents)}</b></article>`).join('') || '<p>A dona ainda não liberou produtos para sua loja.</p>'}</div><p class="rs-muted">A venda pelo estoque compartilhado será liberada após a integração do checkout e dos repasses. Você não recebe acesso aos códigos do fornecedor.</p></section>` : ''}${
      own.permissions.plans === 'approved'
        ? `<section class="rs-card"><h2>Seus preços de planos</h2><p>Primeira contratação e renovações pelo parceiro. O preço precisa cobrir o valor base e a tarifa Purin.</p><form data-plan-prices><div class="rs-grid">${[
            ['monthly', 'Mensal'],
            ['quarterly', 'Trimestral'],
            ['annual', 'Anual'],
          ]
            .map(
              ([key, label]) =>
                `<label>${label}<small>Base Blackout: ${money(plans.basePrices[key] || 0)}</small><input name="${key}" inputmode="decimal" type="number" step="0.01" min="${((plans.basePrices[key] || 0) + 1) / 100}" value="${(plans.prices[key] || 0) / 100}" required></label>`,
            )
            .join(
              '',
            )}</div><button type="submit">Salvar preços</button></form><p class="rs-muted">O link de venda será liberado quando checkout e crédito de comissões estiverem conectados. Salvar preços ainda não habilita cobranças.</p></section>`
        : ''
    }`;
  const renderAdmin = () => {
    const products = data.global.configured ? data.global.catalog.products : [];
    const shown = data.partners.filter(
      (p: any) =>
        filter === 'all' ||
        (filter === 'merchant' && p.kind === 'merchant') ||
        (filter === 'reseller' && p.kind === 'reseller') ||
        (filter === 'pending' && Object.values(p.permissions).includes('requested')),
    );
    return `<div class="rs-metrics"><article><span>Estoque global</span><b>${products.length}</b><small>produtos na fonte central</small></article><article><span>Revendedores</span><b>${data.partners.filter((p: any) => p.kind === 'reseller').length}</b><small>com ao menos uma modalidade aprovada</small></article><article><span>Solicitações</span><b>${data.partners.filter((p: any) => Object.values(p.permissions).includes('requested')).length}</b><small>aguardando sua decisão</small></article></div><section class="rs-card"><div class="rs-card-heading"><div><span class="rs-eyebrow">SUA FONTE DE PRODUTOS</span><h2>Estoque global</h2><p>${data.global.configured ? 'Os produtos e unidades são os mesmos da sua loja, sem duplicar o estoque.' : 'Vincule a sua loja para usá-la como fonte central de produtos.'}</p></div>${data.global.configured ? '<a class="button-link" href="#/minha-loja?section=stock">Configurar modos de estoque</a>' : '<button data-initialize>Usar minha loja como estoque global</button>'}</div>${data.global.configured ? `<div class="rs-catalog">${products.map((p: any) => `<article><span class="rs-badge">${p.stock_mode === 'infinite' ? 'Infinito' : p.stock + ' disponíveis'}</span><h3>${esc(p.title)}</h3><p>${esc(p.category)}</p><button class="quiet" data-global-stock="${p.id}">Gerenciar unidades</button></article>`).join('') || '<p>Cadastre o primeiro produto para começar.</p>'}</div><details><summary>Cadastrar produto no catálogo global</summary><form data-global-product><div class="rs-grid"><label>Nome<input name="title" maxlength="70" required></label><label>Categoria<input name="category" maxlength="40" required></label><label>Preço na sua loja · R$<input name="price" type="number" step="0.01" min="0.01" required></label></div><label>Descrição<textarea name="description" maxlength="400" required></textarea></label><button type="submit">Cadastrar produto</button></form></details>` : ''}</section><section class="rs-card"><div class="rs-card-heading"><div><h2>Lojistas e revendedores</h2><p>Participação em cada modalidade, independente do acesso à loja.</p></div><label>Mostrar<select data-filter><option value="all">Todos</option><option value="merchant">Lojistas comuns</option><option value="reseller">Revendedores</option><option value="pending">Solicitações pendentes</option></select></label></div>${data.truncated ? '<p>Exibindo os primeiros 200 lojistas.</p>' : ''}<div class="rs-partners">${
      shown
        .map(
          (p: any) =>
            `<article><div class="rs-partner-title"><div><h3>${esc(p.storeName)}</h3><small>${esc(p.name)}</small></div><span class="rs-badge">${p.kind === 'owner' ? 'Dona da plataforma' : p.kind === 'reseller' ? 'Revendedor' : 'Lojista comum'}</span></div>${kinds.map(([key, label]) => `<div class="rs-permission"><div><b>${label}</b><small>${esc(labels[p.permissions[key]])}</small></div>${p.permissions[key] === 'requested' ? `<button data-decide="${p.id}" data-cap="${key}" data-status="approved">Aprovar</button>` : ''}${['requested', 'approved'].includes(p.permissions[key]) ? `<button class="quiet" data-decide="${p.id}" data-cap="${key}" data-status="revoked">${p.permissions[key] === 'requested' ? 'Recusar' : 'Revogar'}</button>` : ''}</div>`).join('')}${
              p.permissions.products === 'approved' && products.length
                ? `<details><summary>Produtos liberados (${data.grants.filter((g: any) => g.partnerId === p.id && g.enabled).length})</summary><form data-grant="${p.id}"><label>Produto<select name="productId">${products.map((v: any) => `<option value="${v.id}">${esc(v.title)}</option>`).join('')}</select></label><label>Valor de fornecedor · R$<input name="base" type="number" min="0.01" step="0.01" required></label><button type="submit">Liberar produto</button></form>${data.grants
                    .filter((g: any) => g.partnerId === p.id && g.enabled)
                    .map(
                      (g: any) =>
                        `<div class="rs-permission"><span>${esc(products.find((v: any) => v.id === g.productId)?.title || 'Produto')} · ${money(g.baseCents)}</span><button class="quiet" data-revoke-grant="${esc(g.id)}">Remover autorização</button></div>`,
                    )
                    .join('')}</details>`
                : ''
            }</article>`,
        )
        .join('') || '<p>Nenhum lojista nesta lista.</p>'
    }</div></section>`;
  };
  const stockDialog = async (productId: string) => {
    let inventory = await api('/admin/resale/stock?productId=' + productId);
    const product = data.global.catalog.products.find((p: any) => p.id === productId);
    const dialog = document.createElement('dialog');
    dialog.className = 'rs-stock-dialog';
    dialog.setAttribute('aria-label', 'Unidades do estoque global');
    host.append(dialog);
    const draw = () => {
      dialog.innerHTML = `<div class="rs-card-heading"><div><span class="rs-eyebrow">ESTOQUE GLOBAL</span><h2>${esc(product.title)}</h2><p>${inventory.units.length} unidades individuais salvas · modo ${esc(inventory.mode)}</p></div><button class="quiet" data-close>Fechar</button></div><p class="rs-muted">Pedidos reservados ficam protegidos. Nos modos fantasma e infinito, estas unidades ficam guardadas para o modo individual.</p><div class="rs-actions"><button class="quiet" data-stock-action="shuffle" ${inventory.units.length < 2 ? 'disabled' : ''}>Embaralhar</button><button class="quiet" data-stock-action="clear" ${!inventory.units.length ? 'disabled' : ''}>Apagar disponíveis</button></div><div class="rs-units">${inventory.units.map((u: any, i: number) => `<article><div class="rs-permission"><b>${i + 1}. ${u.kind === 'document' ? 'Arquivo' : 'Código / texto'}</b><button class="quiet" data-stock-action="delete" data-unit="${u.id}">Excluir</button></div><pre>${esc(u.text)}</pre></article>`).join('') || '<p>Nenhuma unidade individual.</p>'}</div><form data-stock-add><label>Adicionar códigos · uma unidade por linha<textarea name="units" rows="3" maxlength="20020" required></textarea></label><button type="submit">Adicionar unidades</button></form><p role="status" data-dialog-feedback></p>`;
      dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
      dialog.querySelectorAll<HTMLButtonElement>('[data-stock-action]').forEach((b) =>
        b.addEventListener(
          'click',
          () =>
            void work(async () => {
              if (
                b.dataset.stockAction !== 'shuffle' &&
                !confirm(
                  'Excluir ' +
                    (b.dataset.stockAction === 'clear'
                      ? 'todas as unidades disponíveis'
                      : 'esta unidade') +
                    '? Esta ação não pode ser desfeita.',
                )
              )
                return;
              await api('/admin/resale/global/stock-manage', {
                productId,
                version: inventory.version,
                action: b.dataset.stockAction,
                ...(b.dataset.unit ? { unitId: b.dataset.unit } : {}),
              });
            }),
        ),
      );
      dialog.querySelector('form')!.addEventListener('submit', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const units = String(new FormData(e.target as HTMLFormElement).get('units'))
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        void work(async () => {
          await api('/admin/resale/global/stock-add', {
            productId,
            units,
            requestId: crypto.randomUUID(),
          });
        });
      });
    };
    const work = async (fn: () => Promise<void>) => {
      dialog.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await fn();
        inventory = await api('/admin/resale/stock?productId=' + productId);
        draw();
      } catch (error) {
        dialog.querySelector('[data-dialog-feedback]')!.textContent =
          error instanceof Error ? error.message : 'Falha ao atualizar.';
        dialog.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    draw();
    dialog.showModal();
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        void refresh();
      },
      { once: true },
    );
  };
  host.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    if (target.matches('[data-filter]')) {
      filter = target.value;
      render();
      host.querySelector<HTMLSelectElement>('[data-filter]')!.value = filter;
    }
  });
  host.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b || b.closest('dialog')) return;
    void run(async () => {
      if (b.hasAttribute('data-initialize')) await api('/admin/resale/initialize', {});
      else if (b.dataset.opt)
        await api('/store/resale/request', {
          capability: b.dataset.opt,
          enabled: b.dataset.enable === 'true',
          revision: own.revision,
        });
      else if (b.dataset.decide) {
        const p = data.partners.find((p: any) => p.id === b.dataset.decide);
        await api('/admin/resale/partners/' + p.id, {
          capability: b.dataset.cap,
          status: b.dataset.status,
          revision: p.revision,
        });
      } else if (b.dataset.globalStock) {
        await stockDialog(b.dataset.globalStock);
        return;
      } else if (b.dataset.revokeGrant) {
        const g = data.grants.find((g: any) => g.id === b.dataset.revokeGrant);
        await api('/admin/resale/grants', {
          partnerId: g.partnerId,
          productId: g.productId,
          baseCents: g.baseCents,
          revision: g.revision,
          enabled: false,
        });
      } else return;
      await refresh();
    });
  });
  host.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (form.closest('dialog')) return;
    e.preventDefault();
    e.stopPropagation();
    const fields = new FormData(form);
    void run(async () => {
      if (form.hasAttribute('data-plan-prices'))
        await api('/store/resale/plans', {
          revision: plans.revision,
          enabled: true,
          prices: Object.fromEntries(
            ['monthly', 'quarterly', 'annual'].map((key) => [
              key,
              Math.round(Number(fields.get(key)) * 100),
            ]),
          ),
        });
      else if (form.hasAttribute('data-global-product'))
        await api('/admin/resale/global/product', {
          title: fields.get('title'),
          category: fields.get('category'),
          description: fields.get('description'),
          price: Math.round(Number(fields.get('price')) * 100),
          enabled: true,
          banner: '',
          revision: data.global.catalog.revision,
        });
      else if (form.dataset.grant) {
        const partnerId = form.dataset.grant,
          productId = String(fields.get('productId')),
          g = data.grants.find((g: any) => g.partnerId === partnerId && g.productId === productId);
        await api('/admin/resale/grants', {
          partnerId,
          productId,
          baseCents: Math.round(Number(fields.get('base')) * 100),
          enabled: true,
          revision: g?.revision ?? 0,
        });
      } else return;
      await refresh();
      feedback('Alterações salvas.');
    });
  });
  await refresh();
}
