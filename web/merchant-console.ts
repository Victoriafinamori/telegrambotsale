import './merchant-console.css';
import { mountPaymentSettings } from './payment-settings.js';
import { mountWallet } from './wallet.js';
import type { Product, ShopStats, Announcement } from '../server/bot-types.js';
type Data = {
  title: string;
  welcome: string;
  banner: string;
  products: Product[];
  categories: string[];
  category_emojis: Record<string, string>;
  support: string;
  support_name: string;
  support_phone: string;
  support_url: string;
  payment_mode: string;
  payment_instructions: string;
  coupons: Record<string, { percent: number; limit: number; used: number }>;
  stats: ShopStats;
  pendingReview: number;
  pendingPayment: number;
  noticeSubscribers: number;
  revision: number;
  botUsername: string;
};
type Order = {
  id: string;
  buyer_name?: string;
  buyer_username?: string;
  buyer_id: string;
  status: string;
  items: { title: string; quantity: number }[];
  total: number;
  currency: string;
  created_at: string;
  hasReceipt: boolean;
  receipt_revision?: number;
  rejection_reason?: string;
};
type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (value: number, currency = 'BRL') =>
  currency === 'BRL'
    ? (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : `${value} ⭐`;
const statuses: Record<string, string> = {
  awaiting_payment: 'Aguardando pagamento',
  awaiting_review: 'Aguardando aprovação',
  paid: 'Entrega pendente',
  delivered: 'Entregue',
  rejected: 'Recusado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
  precheckout: 'Pagamento em processamento',
  refund_required: 'Revisão necessária',
  refund_pending: 'Reembolso pendente',
  refunded: 'Reembolsado',
};
const navigation = [
  ['overview', 'Visão geral'],
  ['products', 'Produtos'],
  ['stock', 'Estoque'],
  ['orders', 'Pedidos'],
  ['wallet', 'Carteira'],
  ['appearance', 'Aparência'],
  ['support', 'Suporte'],
  ['payments', 'Pagamentos'],
  ['coupons', 'Cupons'],
  ['notices', 'Avisos'],
] as const;
const icon = (name: string) => {
  const paths: Record<string, string> = {
    wallet: '<path d="M3 6h16v3H3zM3 9v11h18V9M16 13h5v4h-5z"/>',
    up: '<path d="m6 10 6-6 6 6M12 4v16"/>',
    down: '<path d="m6 14 6 6 6-6M12 20V4"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    overview:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    products: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
    stock: '<path d="M3 7h18v4H3zM5 11v10h14V11M9 15h6M5 7l2-4h10l2 4"/>',
    orders: '<path d="M6 3h12v19l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6M9 16h3"/>',
    appearance: '<path d="m14 5 5 5M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/>',
    support:
      '<path d="M4 13V11a8 8 0 0 1 16 0v2M4 12H3v6h4v-6H4Zm16 0h1v6h-4v-6h3ZM20 18v1a2 2 0 0 1-2 2h-4"/>',
    payments: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    coupons: '<path d="M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V7ZM13 7v2m0 3v2m0 3v2"/>',
    notices: '<path d="m4 10 15-6v16L4 14v-4ZM4 10H2v4h2m3 1 2 6h4l-2-5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    collapse: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m7-12-4 4 4 4"/>',
    expand: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m4-12 4 4-4 4"/>',
    external:
      '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.menu}</svg>`;
};
const input = (name: string, label: string, value: unknown = '', attributes = '') =>
  `<label>${label}<input name="${name}" value="${esc(value)}" ${attributes}></label>`;
const area = (name: string, label: string, value: unknown, max: number) =>
  `<label>${label}<textarea name="${name}" maxlength="${max}" rows="4">${esc(value)}</textarea></label>`;
const picture = (name: string, value: string, label: string) =>
  `<div class="mc-upload"><label>${label}<input type="file" name="${name}Upload" accept="image/png,image/jpeg" data-image="${name}"></label><input type="hidden" name="${name}" value="${esc(value)}"><small>JPG ou PNG · até 3 MB. A imagem também será enviada ao seu bot.</small><div class="mc-preview" data-preview="${name}" ${value ? `data-asset="${esc(value)}"` : ''}>${value ? '<span>Imagem salva</span>' : '<span>Sem imagem</span>'}</div><label class="mc-check"><input type="checkbox" name="${name}Remove"> Remover imagem</label></div>`;
export async function mountMerchantConsole(
  host: HTMLElement,
  api: Api,
  privateFile: (path: string) => Promise<Blob>,
) {
  let data: Data,
    section = location.hash.includes('?wallet=') ? 'wallet' : 'overview',
    category: string | null = null,
    selected: Product | undefined,
    orders: Order[] = [],
    notices: Announcement[] = [],
    cursor = '',
    next: string | null = null,
    pendingOnly = false,
    busy = false;
  const blobs = new Set<string>();
  const mediaCache = new Map<string, Promise<Blob>>();
  const listLoaded = new Set<string>();
  let navigationRequest = 0;
  let listLoading = false;
  let listError = '';
  const media = (path: string) => {
    let request = mediaCache.get(path);
    if (!request) {
      request = privateFile(path).catch((error) => {
        mediaCache.delete(path);
        throw error;
      });
      mediaCache.set(path, request);
    }
    return request;
  };
  let collapsed = false,
    mobileOpen = false;
  try {
    collapsed = localStorage.getItem('blackout.sidebar.collapsed') === 'true';
  } catch {
    /* Optional preference. */
  }
  const mobile = window.matchMedia('(max-width: 760px)');
  const lifecycle = new AbortController();
  const syncNavigation = () => {
    host.querySelector('.mc-layout')?.classList.toggle('mc-collapsed', collapsed);
    host
      .querySelector('.mc-layout')
      ?.classList.toggle('mc-mobile-open', mobile.matches && mobileOpen);
    const sidebar = host.querySelector<HTMLElement>('#mc-sidebar');
    if (sidebar) {
      sidebar.inert = mobile.matches && !mobileOpen;
      if (mobile.matches && mobileOpen) {
        sidebar.setAttribute('role', 'dialog');
        sidebar.setAttribute('aria-modal', 'true');
      } else {
        sidebar.removeAttribute('role');
        sidebar.removeAttribute('aria-modal');
      }
    }
    const main = host.querySelector<HTMLElement>('.mc-main');
    if (main) main.inert = mobile.matches && mobileOpen;
    const toggle = host.querySelector<HTMLButtonElement>('[data-action="toggle-navigation"]');
    if (toggle) {
      const label = mobile.matches
        ? 'Abrir menu da loja'
        : collapsed
          ? 'Expandir menu lateral'
          : 'Recolher menu lateral';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      toggle.setAttribute('aria-expanded', String(mobile.matches ? mobileOpen : !collapsed));
      toggle.innerHTML = `${icon(mobile.matches ? 'menu' : collapsed ? 'expand' : 'collapse')}<span class="mc-toggle-label">${collapsed ? 'Abrir menu' : 'Recolher menu'}</span>`;
    }
  };
  const closeNavigation = (restoreFocus = true) => {
    mobileOpen = false;
    syncNavigation();
    if (restoreFocus)
      host.querySelector<HTMLButtonElement>('[data-action="toggle-navigation"]')?.focus();
  };
  mobile.addEventListener(
    'change',
    () => {
      closeNavigation(false);
    },
    { signal: lifecycle.signal },
  );
  window.addEventListener(
    'hashchange',
    () => {
      closeNavigation(false);
      lifecycle.abort();
    },
    { once: true, signal: lifecycle.signal },
  );
  host.addEventListener('keydown', (event) => {
    if (!mobile.matches || !mobileOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNavigation();
    }
    if (event.key === 'Tab') {
      const items = Array.from(
        host.querySelectorAll<HTMLElement>('#mc-sidebar a, #mc-sidebar button:not(:disabled)'),
      ).filter((el) => el.getClientRects().length > 0);
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  const revoke = () => {
    for (const url of blobs) URL.revokeObjectURL(url);
    blobs.clear();
  };
  const get = async () => {
    data = await api<Data>('/store/manage');
  };
  const alert = (message: string, error = false) => {
    const el = host.querySelector<HTMLElement>('#mc-feedback');
    if (el) {
      el.hidden = false;
      el.textContent = message;
      el.classList.toggle('is-error', error);
    }
  };
  const revision = () => `<input type="hidden" name="revision" value="${data.revision}">`;
  const metric = (label: string, value: string | number) =>
    `<div class="mc-metric"><span>${label}</span><strong>${esc(value)}</strong></div>`;
  const empty = (title: string, text: string) =>
    `<div class="mc-empty"><h3>${title}</h3><p>${text}</p></div>`;
  const settingsFields = () => `<input type="hidden" name="revision" value="${data.revision}">`;
  const updateLivePreview = () => {
    const form = host.querySelector<HTMLFormElement>('form[data-live-preview]');
    const preview = host.querySelector<HTMLElement>('.mc-live-preview');
    if (!form || !preview) return;
    const fields = new FormData(form);
    const value = (name: string) => String(fields.get(name) ?? '').trim();
    const kind = form.dataset.form;
    const photo = kind === 'notice' ? 'photo' : 'banner';
    const image = !fields.has(photo + 'Remove')
      ? form.querySelector<HTMLImageElement>(`[data-preview="${photo}"] img`)
      : null;
    const title =
      kind === 'product'
        ? value('title') || 'Nome do produto'
        : kind === 'support'
          ? value('support_name') || 'Suporte'
          : data.title;
    const text =
      kind === 'product'
        ? value('description')
        : kind === 'appearance'
          ? value('welcome')
          : kind === 'notice'
            ? value('text')
            : kind === 'payments'
              ? value('payment_instructions')
              : [value('support_phone'), value('support_url'), value('support')]
                  .filter(Boolean)
                  .join('\n');
    preview.innerHTML = `<h3>Prévia no Telegram</h3><p class="mc-preview-note">Atualiza enquanto você edita. As mudanças só entram no bot depois de salvar.</p><div class="mc-telegram-preview"><div class="mc-preview-media"></div><strong>${esc(title)}</strong><p class="mc-preview-message">${esc(text || 'Seu texto aparecerá aqui.')}</p>${kind === 'product' ? `<b>${Number.isFinite(Number(value('price'))) ? esc(money(Math.round(Number(value('price')) * (data.payment_mode === 'manual' ? 100 : 1)), data.payment_mode === 'manual' ? 'BRL' : 'XTR')) : 'Preço do produto'}</b>` : ''}</div><div class="mc-preview-controls" aria-hidden="true">${(kind === 'appearance' ? ['Produtos', 'Minhas compras', 'Suporte'] : kind === 'product' ? ['Comprar', 'Voltar'] : kind === 'support' ? ['Falar com o suporte'] : kind === 'payments' ? ['Enviar comprovante'] : []).map((label) => `<span>${label}</span>`).join('')}</div><small>Representação aproximada; o Telegram adapta fontes e botões ao aparelho.</small>`;
    if (image) preview.querySelector('.mc-preview-media')!.append(image.cloneNode());
  };
  const mountLivePreview = () => {
    const form = host.querySelector<HTMLFormElement>('form[data-form]');
    if (
      !form ||
      !['product', 'appearance', 'support', 'payments', 'notice'].includes(form.dataset.form!)
    )
      return;
    form.dataset.livePreview = 'true';
    const panel = form.closest<HTMLElement>('.mc-panel')!;
    panel.classList.add('mc-editor-panel');
    const preview = document.createElement('aside');
    preview.className = 'mc-live-preview';
    preview.setAttribute('aria-label', 'Prévia das alterações');
    panel.append(preview);
    updateLivePreview();
  };
  const render = () => {
    revoke();
    let body = '';
    if (section === 'overview')
      body = `<div class="mc-metrics">${metric('Vendas aprovadas', money(data.stats.gross_brl))}${metric('Compradores', data.stats.buyers)}${metric('Pedidos entregues', data.stats.delivered_orders)}${metric('Para aprovar', data.pendingReview)}</div><section class="mc-panel"><div class="mc-panel-head"><h2>Seu próximo passo</h2><button data-section="orders">Conferir pedidos</button></div><p>Configure a vitrine e o atendimento. As alterações salvas aqui são usadas pelo seu bot no Telegram.</p><div class="mc-shortcuts"><button class="quiet" data-section="products">Produtos e fotos</button><button class="quiet" data-section="appearance">Mensagem de entrada</button><button class="quiet" data-section="payments">Dados de pagamento</button></div><dl><div><dt>Pedidos criados</dt><dd>${data.stats.orders}</dd></div><div><dt>Aguardando pagamento</dt><dd>${data.pendingPayment}</dd></div><div><dt>Recusados</dt><dd>${data.stats.rejected_orders}</dd></div><div><dt>Vendas em Stars</dt><dd>${money(data.stats.gross_stars, 'XTR')}</dd></div></dl></section>`;
    if (section === 'products') {
      const names = [
        ...new Set([...(data.categories ?? []), ...data.products.map((p) => p.category)]),
      ].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      const products = data.products.filter((p) => p.category === category);
      body =
        category === null
          ? `<section class="mc-panel"><div class="mc-panel-head"><div><h2>Categorias</h2><p>Organize o catálogo. Escolha uma categoria para cadastrar ou editar seus produtos.</p></div></div><form data-form="category" class="mc-category-form">${revision()}${input('name', 'Nova categoria', '', 'required maxlength="40" placeholder="Ex.: Cursos, arquivos, licenças"')}${input('emoji', 'Emoji (opcional)', '', 'maxlength="32" placeholder="Cole o emoji que preferir"')}<button type="submit">Criar categoria</button></form><div class="mc-category-list">${
              names
                .map((name) => {
                  const count = data.products.filter((p) => p.category === name).length;
                  return `<button class="mc-category" data-category="${esc(name)}">${data.category_emojis?.[name] ? `<span aria-hidden="true">${esc(data.category_emojis[name])}</span>` : ''}<span><strong>${esc(name)}</strong><small>${count} ${count === 1 ? 'produto' : 'produtos'}</small></span>${icon('chevron')}</button>`;
                })
                .join('') ||
              empty(
                'Crie a primeira categoria',
                'Depois, adicione os produtos que fazem parte dela.',
              )
            }</div></section>`
          : `<section class="mc-panel"><div class="mc-panel-head"><div><button class="text-button" data-action="all-categories">Voltar às categorias</button><h2 tabindex="-1">${esc(category)}</h2><p>${products.length} ${products.length === 1 ? 'produto nesta categoria' : 'produtos nesta categoria'}</p></div><button data-action="new-product">Adicionar produto</button></div><div class="mc-category-tools"><button class="quiet" data-action="rename-category">${icon('appearance')}Editar categoria</button><button class="quiet" data-action="delete-category">${icon('trash')}Excluir categoria</button></div><p class="mc-order-help">Use as setas para definir a ordem dos produtos no Telegram.</p><div class="mc-product-list">${products.map((p, index) => `<div class="mc-product-row" data-product-id="${p.id}"><button class="mc-product" data-edit="${p.id}"><span class="mc-product-image" ${p.banner ? `data-asset="${esc(p.banner)}"` : ''}>Sem foto</span><span><strong>${esc(p.title)}</strong><small>${p.enabled ? 'Disponível' : 'Oculto'}</small></span><span><b>${money(p.price, data.payment_mode === 'manual' ? 'BRL' : 'XTR')}</b><small>${p.stock} un. · Editar</small></span></button><div class="mc-product-order" role="group" aria-label="Ordem de ${esc(p.title)}"><button class="mc-icon-button" data-move="${p.id}" data-direction="up" aria-label="Mover ${esc(p.title)} para cima" title="Mover para cima" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="mc-icon-button" data-move="${p.id}" data-direction="down" aria-label="Mover ${esc(p.title)} para baixo" title="Mover para baixo" ${index === products.length - 1 ? 'disabled' : ''}>${icon('down')}</button></div></div>`).join('') || empty('Esta categoria ainda está vazia', 'Use Adicionar produto para começar.')}</div></section>`;
    }
    if (section === 'product-edit') {
      const p = selected;
      body = `<section class="mc-panel"><div class="mc-panel-head"><h2>${p ? 'Editar produto' : 'Novo produto'}</h2><button class="quiet" data-section="products">Voltar ao catálogo</button></div><form data-form="product">${revision()}${p ? `<input type="hidden" name="id" value="${p.id}">` : ''}${input('title', 'Nome do produto', p?.title ?? '', 'required maxlength="70"')}${area('description', 'Descrição', p?.description ?? '', 400)}<div class="mc-form-row"><label>Categoria<select name="category" required><option value="">Escolha uma categoria</option>${[
        ...new Set([...(data.categories ?? []), ...data.products.map((v) => v.category)]),
      ]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map(
          (name) =>
            `<option value="${esc(name)}" ${name === (p?.category ?? category) ? 'selected' : ''}>${esc(name)}</option>`,
        )
        .join(
          '',
        )}</select></label>${input('price', data.payment_mode === 'manual' ? 'Preço · R$' : 'Preço · Stars', p ? (data.payment_mode === 'manual' ? p.price / 100 : p.price) : '', 'type="number" required min="0.01" max="100000" step="' + (data.payment_mode === 'manual' ? '0.01' : '1') + '"')}</div>${picture('banner', p?.banner ?? '', 'Foto do produto · opcional')}${data.payment_mode === 'manual' ? picture('pix_qr', p?.pix_qr ?? '', 'QR Code Pix deste produto · opcional') + '<p class="mc-note">Envie o QR gerado no seu banco para o preço deste produto. Usado no Pix manual para uma unidade, sem cupom. Carrinhos com vários itens ou quantidade maior recebem os dados Pix manuais. Ao mudar o preço, envie um QR atualizado; o anterior não será usado para o novo valor.</p>' : ''}<label class="mc-check"><input type="checkbox" name="enabled" ${p?.enabled !== false ? 'checked' : ''}> Disponível no catálogo</label><button type="submit">Salvar produto</button></form></section>`;
    }
    if (section === 'stock')
      body = `<section class="mc-panel"><h2>Adicionar estoque</h2><p>Cada linha é uma unidade exclusiva. O conteúdo é cifrado e entregue após a aprovação do pagamento.</p>${data.products.length ? `<form data-form="stock"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><label>Produto<select name="productId">${data.products.map((p) => `<option value="${p.id}">${esc(p.title)} · ${p.stock} disponíveis</option>`).join('')}</select></label>${area('units', 'Uma unidade por linha', '', 20020)}<small>Até 20 unidades por envio · 100 disponíveis por produto. Os códigos existentes não são exibidos neste painel.</small><button type="submit">Adicionar unidades</button></form><p>Para adicionar arquivos digitais ao estoque, envie o arquivo em <b>/admin → Estoque</b> no bot. Fotos da vitrine podem ser enviadas pelo próprio site.</p>` : empty('Cadastre um produto primeiro', 'Depois ele aparecerá aqui para receber estoque.')}</section>`;
    if (section === 'orders')
      body = `<section class="mc-panel"><div class="mc-panel-head"><h2>Pedidos</h2><button class="quiet" data-action="toggle-pending">${pendingOnly ? 'Ver todos' : 'Só aguardando aprovação'}</button></div>${orders.length ? orders.map((o) => `<article class="mc-order"><div class="mc-panel-head"><div><b>Pedido ${o.id}</b><small>${new Date(o.created_at).toLocaleString('pt-BR')}</small></div><span class="badge">${statuses[o.status] ?? esc(o.status)}</span></div><p><b>${esc(o.buyer_name || o.buyer_id)}</b>${o.buyer_username ? ' · @' + esc(o.buyer_username) : ''}</p><p>${o.items.map((i) => `${i.quantity} × ${esc(i.title)}`).join('<br>')}</p><strong>${money(o.total, o.currency)}</strong>${o.rejection_reason ? `<p>Recusa: ${esc(o.rejection_reason)}</p>` : ''}<div class="mc-shortcuts">${o.hasReceipt ? `<button class="quiet" data-receipt="${o.id}">Ver comprovante</button>` : ''}${o.status === 'awaiting_review' ? `<button data-approve="${o.id}" data-revision="${o.receipt_revision}">Aprovar e entregar</button><button class="quiet" data-reject="${o.id}" data-revision="${o.receipt_revision}">Recusar</button>` : ''}</div></article>`).join('') : empty('Nenhum pedido nesta lista', 'As compras feitas no Telegram aparecerão aqui com os itens e a situação do pagamento.')}<div class="mc-shortcuts">${cursor ? '<button class="quiet" data-action="first-orders">Primeira página</button>' : ''}${next ? '<button class="quiet" data-action="next-orders">Próxima página</button>' : ''}</div></section>`;
    if (section === 'appearance')
      body = `<section class="mc-panel"><h2>Entrada da loja</h2><p>O nome <b>${esc(data.title)}</b> acompanha o BotFather. Aqui você altera a mensagem e a imagem de entrada.</p><form data-form="appearance">${settingsFields()}${area('welcome', 'Mensagem de boas-vindas', data.welcome, 600)}${picture('banner', data.banner, 'Banner de entrada · opcional')}<button type="submit">Salvar aparência</button></form></section>`;
    if (section === 'support')
      body = `<section class="mc-panel"><h2>Atendimento</h2><p>Esses dados aparecem para o comprador ao abrir Suporte no bot.</p><form data-form="support">${settingsFields()}${input('support_name', 'Nome do suporte', data.support_name, 'maxlength="80"')}${input('support_phone', 'Telefone com DDD', data.support_phone, 'maxlength="32" type="tel"')}${input('support_url', 'Link de atendimento', data.support_url, 'type="url" maxlength="500" placeholder="https://wa.me/…"')}${input('support', 'Usuário Telegram · opcional', data.support, 'maxlength="33" placeholder="@seu_atendimento"')}<button type="submit">Salvar suporte</button></form></section>`;
    if (section === 'coupons')
      body = `<section class="mc-panel"><h2>Cupons de desconto</h2>${
        Object.entries(data.coupons)
          .map(
            ([code, c]) =>
              `<div class="mc-line"><b>${esc(code)}</b><span>${c.percent}% · ${c.used}/${c.limit} usos reservados/aplicados</span></div>`,
          )
          .join('') || '<p>Nenhum cupom cadastrado.</p>'
      }<form data-form="coupon"><div class="mc-form-row">${input('code', 'Código', '', 'required pattern="[A-Za-z0-9_-]{3,20}" maxlength="20"')}${input('percent', 'Desconto · %', '', 'type="number" required min="1" max="90"')}${input('limit', 'Limite de usos', '', 'type="number" required min="1" max="99999"')}</div><button type="submit">Criar cupom</button></form></section>`;
    if (section === 'notices')
      body = `<section class="mc-panel"><div class="mc-panel-head"><div><h2>Avisos</h2><p>${data.noticeSubscribers} inscritos no recebimento</p></div></div><form data-form="notice"><input type="hidden" name="requestId" value="${crypto.randomUUID()}">${area('text', 'Texto do aviso', '', 900)}${picture('photo', '', 'Foto do aviso · opcional')}<button type="submit">Salvar rascunho e prévia</button><small>Salvar não envia. Você confirma o envio na prévia do rascunho.</small></form></section><section class="mc-panel"><h2>Histórico de avisos</h2>${notices.map((n) => `<article class="mc-order"><div class="mc-panel-head"><b>${{ draft: 'Rascunho', queued: 'Na fila', sending: 'Enviando', completed: 'Concluído', cancelled: 'Cancelado' }[n.status]}</b><small>${new Date(n.created_at).toLocaleString('pt-BR')}</small></div><p class="mc-notice-text">${esc(n.text)}</p>${n.photo ? `<div class="mc-product-image" data-asset="${esc(n.photo)}">Foto</div>` : ''}<small>Enviados: ${n.sent} · Falhas: ${n.failed} · Incertos: ${n.uncertain} · Ignorados: ${n.skipped}</small>${n.status === 'draft' ? `<button data-send-notice="${n.id}">Revisar e confirmar envio</button>` : ['sending', 'queued'].includes(n.status) ? `<button class="quiet" data-cancel-notice="${n.id}">Cancelar próximos envios</button>` : ''}</article>`).join('') || '<p>Nenhum aviso criado.</p>'}</section>`;
    host.innerHTML = `<div class="mc-layout"><button class="mc-backdrop" data-action="close-navigation" tabindex="-1" aria-label="Fechar menu da loja"></button><aside id="mc-sidebar" class="mc-sidebar" aria-label="Menu da loja"><div class="mc-store"><span class="mc-store-mark" aria-hidden="true">${esc(data.title.trim().slice(0, 1).toUpperCase() || 'B')}</span><div class="mc-store-info"><h1>${esc(data.title)}</h1><span>@${esc(data.botUsername)}</span></div><button class="mc-icon-button mc-mobile-close" data-action="close-navigation" aria-label="Fechar menu da loja">${icon('close')}</button></div><nav aria-label="Gestão da loja">${navigation
      .map(([id, title], index) => {
        const active = section === id || (section === 'product-edit' && id === 'products');
        return `${index === 0 ? '<span class="mc-nav-group">Operação</span>' : id === 'wallet' ? '<span class="mc-nav-group">Financeiro</span>' : id === 'appearance' ? '<span class="mc-nav-group">Personalização</span>' : ''}<button class="mc-nav-item ${active ? 'active' : ''}" data-section="${id}" aria-label="${title}" title="${title}" ${active ? 'aria-current="page"' : ''}>${icon(id)}<span class="mc-nav-label">${title}</span></button>`;
      })
      .join(
        '',
      )}</nav><div class="mc-sidebar-footer"><a href="https://t.me/${esc(data.botUsername)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir meu bot no Telegram" title="Abrir meu bot no Telegram">${icon('external')}<span class="mc-nav-label">Abrir meu bot</span></a><a href="#/configuracao" class="mc-back" aria-label="Ativação e conexão" title="Ativação e conexão">${icon('back')}<span class="mc-nav-label">Ativação e conexão</span></a></div></aside><div class="mc-main"><div class="mc-title"><div class="mc-page-heading"><button class="mc-icon-button mc-menu-toggle" data-action="toggle-navigation" aria-controls="mc-sidebar">${icon('menu')}</button><h2 tabindex="-1">${navigation.find(([id]) => id === section)?.[1] ?? (section === 'product-edit' && !selected ? 'Novo produto' : 'Editar produto')}</h2></div><button class="quiet" data-action="refresh">Atualizar</button></div><p id="mc-feedback" class="feedback" role="status" hidden></p>${body}</div></div>`;
    if (listLoading || listError) {
      const main = host.querySelector('.mc-main')!;
      if (listLoading && !listLoaded.has(section))
        main.querySelectorAll('.mc-panel').forEach((el) => el.remove());
      const status = document.createElement('p');
      status.className = 'mc-list-status';
      status.setAttribute('role', listError ? 'alert' : 'status');
      status.textContent = listError || 'Carregando registros…';
      main.querySelector('.mc-title')!.after(status);
    }
    syncNavigation();
    mountLivePreview();
    if (section === 'wallet') {
      const wallet = document.createElement('div');
      host.querySelector('.mc-main')!.append(wallet);
      wallet.innerHTML = '<p role="status">Carregando sua carteira…</p>';
      void mountWallet(wallet, api);
    }
    if (section === 'payments') {
      const main = host.querySelector<HTMLElement>('.mc-main')!;
      main.querySelectorAll('.mc-panel').forEach((panel) => panel.remove());
      const settings = document.createElement('div');
      main.append(settings);
      settings.innerHTML = '<p role="status">Carregando opções de pagamento…</p>';
      void mountPaymentSettings(settings, api, get);
    }
    void loadImages();
  };
  const loadImages = async () => {
    await Promise.all(
      Array.from(host.querySelectorAll<HTMLElement>('[data-asset]'), async (el) => {
        try {
          const blob = await media('/store/manage/media/' + encodeURIComponent(el.dataset.asset!));
          if (!el.isConnected) return;
          const url = URL.createObjectURL(blob);
          blobs.add(url);
          const img = new Image();
          img.src = url;
          img.alt = 'Imagem do produto ou aviso';
          el.replaceChildren(img);
          updateLivePreview();
        } catch {
          el.textContent = 'Imagem salva';
        }
      }),
    );
  };
  const refreshSection = async () => {
    const target = section;
    const request = ++navigationRequest;
    const loadList = async () => {
      if (target === 'orders') {
        const page = await api<{ orders: Order[]; next: string | null }>(
          '/store/manage/orders?cursor=' + cursor + '&pending=' + pendingOnly,
        );
        if (request !== navigationRequest) return;
        orders = page.orders;
        next = page.next;
      }
      if (target === 'notices')
        notices = (await api<{ notices: Announcement[] }>('/store/manage/notices')).notices;
    };
    await Promise.all([get(), loadList()]);
    if (request !== navigationRequest) return;
    listLoaded.add(target);
    listLoading = false;
    listError = '';
    render();
  };
  const openSection = async (target: string) => {
    if (target === 'orders' && cursor) listLoaded.delete('orders');
    section = target;
    if (target === 'products') category = null;
    selected = undefined;
    cursor = '';
    const request = ++navigationRequest;
    listError = '';
    listLoading = ['orders', 'notices'].includes(target) && !listLoaded.has(target);
    render();
    host.querySelector<HTMLElement>('.mc-title h2')?.focus();
    if (!listLoading) return;
    try {
      if (target === 'orders') {
        const page = await api<{ orders: Order[]; next: string | null }>(
          '/store/manage/orders?cursor=&pending=' + pendingOnly,
        );
        if (request !== navigationRequest || !host.isConnected) return;
        orders = page.orders;
        next = page.next;
      } else {
        const result = await api<{ notices: Announcement[] }>('/store/manage/notices');
        if (request !== navigationRequest || !host.isConnected) return;
        notices = result.notices;
      }
      listLoaded.add(target);
    } catch (error) {
      if (request !== navigationRequest) return;
      listError =
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar. Use Atualizar para tentar novamente.';
    }
    if (request !== navigationRequest) return;
    listLoading = false;
    render();
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    host.setAttribute('aria-busy', 'true');
    const btns = [...host.querySelectorAll<HTMLButtonElement>('button')].map((button) => ({
      button,
      disabled: button.disabled,
    }));
    btns.forEach(({ button }) => (button.disabled = true));
    try {
      await work();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Não foi possível salvar.', true);
    } finally {
      busy = false;
      host.removeAttribute('aria-busy');
      btns.forEach(({ button, disabled }) => (button.disabled = disabled));
    }
  };
  const confirm = (
    title: string,
    text: string,
    label: string,
    action: () => Promise<void>,
    reason = false,
  ) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `<div class="card-heading"><h2>${title}</h2><button type="button" class="quiet" data-close aria-label="Fechar">✕</button></div><p>${esc(text)}</p><form>${reason ? area('reason', 'Motivo da recusa', '', 300) : ''}<div class="mc-shortcuts"><button type="button" class="quiet" data-close>Voltar</button><button type="submit">${label}</button></div><p role="alert" hidden></p></form>`;
    host.append(dialog);
    dialog
      .querySelectorAll('[data-close]')
      .forEach((b) => b.addEventListener('click', () => dialog.remove()));
    dialog.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = dialog.querySelector('form')!;
      const reasonValue = String(new FormData(form).get('reason') ?? '').trim();
      if (reason && reasonValue.length < 3) {
        const error = dialog.querySelector<HTMLElement>('[role=alert]')!;
        error.hidden = false;
        error.textContent = 'Informe um motivo com pelo menos 3 caracteres.';
        return;
      }
      dialog.dataset.reason = reasonValue;
      void run(async () => {
        try {
          await action();
        } catch (error) {
          const feedback = dialog.querySelector<HTMLElement>('[role=alert]')!;
          feedback.hidden = false;
          feedback.textContent =
            error instanceof Error
              ? error.message
              : 'Não foi possível concluir. Atualize a lista e tente novamente.';
          return;
        }
        dialog.remove();
        await refreshSection();
        alert('Ação registrada.');
      });
    });
    dialog.showModal();
    return dialog;
  };
  const categoryDialog = (action: 'rename' | 'delete') => {
    if (category === null || busy) return;
    const name = category,
      revision = data.revision;
    const count = data.products.filter((p) => p.category === name).length;
    const destinations = [
      ...new Set([...(data.categories ?? []), ...data.products.map((p) => p.category)]),
    ]
      .filter((n) => n !== name)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const dialog = document.createElement('dialog');
    dialog.className = 'mc-category-dialog';
    dialog.setAttribute('aria-labelledby', 'mc-category-dialog-title');
    dialog.innerHTML = `<h2 id="mc-category-dialog-title">${action === 'rename' ? 'Editar categoria' : 'Excluir categoria'}</h2><p><strong>${esc(name)}</strong></p><form>${action === 'rename' ? input('newName', 'Nome da categoria', name, 'required maxlength="40"') + input('emoji', 'Emoji (opcional)', data.category_emojis?.[name] ?? '', 'maxlength="32" placeholder="Cole um emoji ou deixe vazio"') : count ? `<p>${count} ${count === 1 ? 'produto será movido' : 'produtos serão movidos'} para outra categoria, preservando estoque, preços e pedidos.</p>${destinations.length ? `<label>Mover produtos para<select name="destination" required><option value="">Escolha a categoria de destino</option>${destinations.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>` : '<p>Crie outra categoria no catálogo para receber estes produtos antes de excluir esta.</p>'}` : '<p>Esta categoria está vazia. Confirme para removê-la do catálogo.</p>'}<div class="mc-shortcuts"><button class="quiet" type="button" data-close>Cancelar</button><button type="submit" ${action === 'delete' && count && !destinations.length ? 'disabled' : ''}>${action === 'rename' ? 'Salvar categoria' : count ? 'Mover produtos e excluir categoria' : 'Excluir categoria'}</button></div><p role="alert" hidden></p></form>`;
    host.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const fields = new FormData(event.target as HTMLFormElement);
      const newName = String(fields.get('newName') ?? '').trim();
      void run(async () => {
        try {
          await api('/store/manage/categories/manage', {
            action,
            name,
            revision,
            ...(action === 'rename'
              ? { newName, emoji: String(fields.get('emoji') ?? '').trim() }
              : count
                ? { destination: String(fields.get('destination') ?? '') }
                : {}),
          });
        } catch (error) {
          const feedback = dialog.querySelector<HTMLElement>('[role="alert"]')!;
          feedback.hidden = false;
          feedback.textContent =
            error instanceof Error
              ? error.message
              : 'Não foi possível alterar a categoria. Atualize e tente novamente.';
          return;
        }
        category = action === 'rename' ? newName : null;
        dialog.close();
        await refreshSection();
        alert(
          action === 'rename'
            ? 'Categoria renomeada.'
            : 'Categoria excluída. Os produtos foram preservados.',
        );
      });
    });
    dialog.showModal();
    (
      dialog.querySelector<HTMLElement>('input, select') ??
      dialog.querySelector<HTMLElement>('[data-close]')
    )?.focus();
  };
  host.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.closest('dialog')) return;
    event.stopPropagation();
    if (
      button.dataset.action === 'rename-category' ||
      button.dataset.action === 'delete-category'
    ) {
      categoryDialog(button.dataset.action === 'rename-category' ? 'rename' : 'delete');
      return;
    }
    if (button.dataset.move) {
      const productId = button.dataset.move;
      void run(async () => {
        await api('/store/manage/products/order', {
          productId,
          direction: button.dataset.direction,
          revision: data.revision,
        });
        await refreshSection();
        host.querySelector<HTMLElement>(`[data-product-id="${productId}"] .mc-product`)?.focus();
        alert('Ordem dos produtos atualizada no Telegram.');
      });
      return;
    }
    if (button.dataset.action === 'toggle-navigation') {
      if (mobile.matches) {
        mobileOpen = true;
        syncNavigation();
        host.querySelector<HTMLButtonElement>('.mc-mobile-close')?.focus();
      } else {
        collapsed = !collapsed;
        try {
          localStorage.setItem('blackout.sidebar.collapsed', String(collapsed));
        } catch {
          /* Optional preference. */
        }
        syncNavigation();
      }
      return;
    }
    if (button.dataset.action === 'close-navigation') {
      closeNavigation();
      return;
    }
    if (button.dataset.category !== undefined) {
      if (busy) return;
      category = button.dataset.category;
      section = 'products';
      render();
      host.querySelector<HTMLElement>('.mc-panel h2')?.focus();
      return;
    }
    if (button.dataset.action === 'all-categories') {
      category = null;
      section = 'products';
      render();
      return;
    }
    if (button.dataset.section) {
      if (busy) return;
      closeNavigation(false);
      void openSection(button.dataset.section);
      return;
    }
    if (button.dataset.edit) {
      selected = data.products.find((p) => p.id === button.dataset.edit);
      section = 'product-edit';
      render();
      return;
    }
    const action = button.dataset.action;
    if (action === 'new-product') {
      selected = undefined;
      section = 'product-edit';
      render();
      return;
    }
    if (action === 'refresh') {
      void run(refreshSection);
      return;
    }
    if (action === 'toggle-pending') {
      pendingOnly = !pendingOnly;
      cursor = '';
      void run(refreshSection);
      return;
    }
    if (action === 'first-orders' || action === 'next-orders') {
      cursor = action === 'first-orders' ? '' : (next ?? '');
      void run(refreshSection);
      return;
    }
    if (button.dataset.receipt) {
      void run(async () => {
        const blob = await privateFile(
          '/store/manage/orders/' + button.dataset.receipt + '/receipt',
        );
        const url = URL.createObjectURL(blob);
        blobs.add(url);
        const dialog = document.createElement('dialog');
        dialog.innerHTML = `<div class="card-heading"><h2>Comprovante</h2><button class="quiet" type="button">Fechar</button></div>${blob.type.startsWith('image/') ? `<img class="mc-proof" src="${url}" alt="Comprovante do pedido">` : `<a href="${url}" target="_blank" rel="noopener">Abrir arquivo do comprovante</a>`}`;
        dialog.querySelector('button')!.onclick = () => dialog.remove();
        host.append(dialog);
        dialog.showModal();
      });
      return;
    }
    const approve = button.dataset.approve,
      reject = button.dataset.reject;
    if (approve || reject) {
      const id = approve ?? reject!,
        requestId = crypto.randomUUID();
      const dialog = confirm(
        approve ? 'Aprovar pagamento e entregar' : 'Recusar comprovante',
        approve
          ? 'Confirme que o valor deste pedido foi recebido. A aprovação agenda a entrega dos produtos ao comprador.'
          : 'O comprador receberá o motivo, e a reserva do estoque será liberada.',
        approve ? 'Recebi o pagamento. Aprovar' : 'Registrar recusa',
        () =>
          api('/store/manage/commands', {
            command: `admin:review-${approve ? 'approve' : 'reject'}:${id}:${button.dataset.revision}`,
            requestId,
            ...(reject ? { reason: dialog.dataset.reason } : {}),
          }).then(() => {}),
        Boolean(reject),
      );
      return;
    }
    const nid = button.dataset.sendNotice ?? button.dataset.cancelNotice;
    if (nid) {
      const send = Boolean(button.dataset.sendNotice),
        n = notices.find((n) => n.id === nid);
      confirm(
        send ? 'Confirmar envio do aviso' : 'Cancelar próximos envios',
        send
          ? `${n?.text}\n\nEnviar aos inscritos desta loja? Mensagens enviadas não podem ser recolhidas.`
          : 'As mensagens ainda não transmitidas serão canceladas. Mensagens já enviadas podem chegar.',
        send ? 'Confirmar envio' : 'Cancelar aviso',
        () =>
          api('/store/manage/commands', {
            command: `admin:notice-${send ? 'send' : 'cancel'}:${nid}`,
            requestId: crypto.randomUUID(),
          }).then(() => {}),
      );
    }
  });
  host.addEventListener('input', () => updateLivePreview());
  host.addEventListener('change', (event) => {
    const field = event.target as HTMLInputElement;
    updateLivePreview();
    if (!field.matches('[data-image]') || !field.files?.[0]) return;
    event.stopPropagation();
    void run(async () => {
      const file = field.files![0];
      if (file.size > 3 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type))
        throw Error('Escolha JPG ou PNG de até 3 MB.');
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(Error('Falha ao ler a imagem.'));
        reader.readAsDataURL(file);
      });
      const result = await api<{ fileId: string }>('/store/manage/media', { data: encoded });
      const form = field.closest('form')!;
      form.querySelector<HTMLInputElement>(`[name="${field.dataset.image}"]`)!.value =
        result.fileId;
      const preview = form.querySelector(`[data-preview="${field.dataset.image}"]`)!;
      const url = URL.createObjectURL(file);
      blobs.add(url);
      preview.innerHTML = `<img src="${url}" alt="Prévia da imagem escolhida">`;
      updateLivePreview();
      alert('Imagem enviada. Salve o formulário para aplicá-la.');
    });
  });
  host.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.dataset.form) return;
    event.preventDefault();
    event.stopPropagation();
    void run(async () => {
      const fields = new FormData(form),
        value = (name: string) => String(fields.get(name) ?? ''),
        kind = form.dataset.form;
      if (kind === 'category') {
        await api('/store/manage/categories', {
          name: value('name'),
          emoji: value('emoji'),
          revision: Number(value('revision')),
        });
        category = value('name').trim();
      } else if (kind === 'product') {
        await api('/store/manage/products', {
          ...(value('id') ? { id: value('id') } : {}),
          title: value('title'),
          description: value('description'),
          category: value('category'),
          price: Math.round(Number(value('price')) * (data.payment_mode === 'manual' ? 100 : 1)),
          enabled: fields.has('enabled'),
          banner: fields.has('bannerRemove') ? '' : value('banner'),
          ...(data.payment_mode === 'manual'
            ? { pix_qr: fields.has('pix_qrRemove') ? '' : value('pix_qr') }
            : {}),
          revision: Number(value('revision')),
        });
        section = 'products';
        category = value('category');
      } else if (kind === 'stock') {
        const units = value('units')
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean);
        await api('/store/manage/stock', {
          productId: value('productId'),
          units,
          requestId: value('requestId'),
        });
      } else if (kind === 'coupon')
        await api('/store/manage/coupons', {
          code: value('code'),
          percent: Number(value('percent')),
          limit: Number(value('limit')),
        });
      else if (kind === 'notice') {
        const result = await api<{ id: string }>('/store/manage/notices', {
          text: value('text'),
          photo: fields.has('photoRemove') ? '' : value('photo'),
          requestId: value('requestId'),
        });
        alert('Rascunho salvo. Confirme o envio no histórico.');
      } else {
        const settings = {
          welcome: data.welcome,
          banner: data.banner,
          support: data.support,
          support_name: data.support_name,
          support_phone: data.support_phone,
          support_url: data.support_url,
          payment_instructions: data.payment_instructions,
          revision: Number(value('revision')),
        };
        if (kind === 'appearance') {
          settings.welcome = value('welcome');
          settings.banner = fields.has('bannerRemove') ? '' : value('banner');
        }
        if (kind === 'support')
          for (const key of ['support', 'support_name', 'support_phone', 'support_url'] as const)
            settings[key] = value(key);
        if (kind === 'payments') settings.payment_instructions = value('payment_instructions');
        await api('/store/manage/settings', settings);
      }
      form
        .querySelectorAll<HTMLTextAreaElement>('textarea[name=units]')
        .forEach((el) => (el.value = ''));
      await refreshSection();
      alert(
        kind === 'notice'
          ? 'Rascunho salvo. Nenhum aviso foi enviado.'
          : kind === 'category'
            ? 'Categoria criada. Adicione os produtos dela.'
            : 'Alterações salvas. Seu bot já usa estes dados.',
      );
    });
  });
  await get();
  render();
}
