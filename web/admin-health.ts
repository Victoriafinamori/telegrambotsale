import type { AdminHealth } from '../server/admin-health.js';
import './admin-health.css';
type Health = Awaited<ReturnType<AdminHealth['read']>>;
type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const dates = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : 'Ainda não recebido';
const labels: Record<string, string> = {
  online: 'Conectado',
  offline: 'Sem sinal recente',
  unconfigured: 'Não publicado',
  never_seen: 'Aguardando primeiro sinal',
  revoked: 'Credencial revogada',
  mismatch: 'Vínculo diferente',
  pending: 'Pendente',
  configuring: 'Em configuração',
  changes_requested: 'Correção solicitada',
  active: 'Ativado',
  not_submitted: 'Dados não enviados',
  awaiting_payment: 'Aguardando pagamento',
  creating: 'Gerando cobrança',
  uncertain: 'Em conferência',
  review_required: 'Revisão necessária',
};
export async function mountAdminHealth(
  host: HTMLElement,
  api: Api,
  inspect: (id: string) => Promise<void>,
) {
  let state: Health | null = null,
    cursor = '',
    stack: string[] = [],
    busy = false,
    filter = 'all',
    error = '';
  const render = () => {
    if (!host.isConnected) return;
    const positions = [
      document.scrollingElement,
      ...Array.from(host.closest('main')?.querySelectorAll<HTMLElement>('[data-scroll]') ?? []),
    ]
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .map((el) => ({ el, top: el.scrollTop }));
    const rows =
      state?.rows.filter(
        (row) =>
          filter === 'all' ||
          (filter === 'attention' && row.alerts.some((a) => a.severity === 'attention')) ||
          (filter === 'connection' &&
            ['offline', 'never_seen', 'revoked', 'mismatch'].includes(row.connection)) ||
          (filter === 'activation' && row.activationPending) ||
          (filter === 'payments' &&
            row.counts.waitingPayment + row.counts.manualReview + row.counts.paymentIssues > 0) ||
          (filter === 'delivery' && row.counts.deliveryIssues > 0),
      ) ?? [];
    host.innerHTML = `<div class="health-heading"><div><h2>Saúde dos bots</h2><p>Conexão, pagamentos, entregas e ativações em uma consulta.</p></div><button type="button" data-health-refresh ${busy ? 'disabled' : ''}>${busy ? 'Consultando…' : 'Atualizar situação'}</button></div><p role="status" class="health-error" ${error ? '' : 'hidden'}>${esc(error)}</p>${
      state
        ? `<p class="health-updated">Consulta em ${dates(state.checkedAt)}. A conexão usa o heartbeat dos últimos 90 segundos; não é uma consulta ao processo da hospedagem.</p><div class="health-summary">${[
            ['Lojas nesta página', state.summary.stores],
            ['Conectados', state.summary.online],
            ['Precisam de atenção', state.summary.needsAttention],
            ['Ativações pendentes', state.summary.activationPending],
          ]
            .map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`)
            .join(
              '',
            )}</div><p class="health-hosting">Novas ativações na ${esc(state.hosting.provider)}: <strong>${state.hosting.enabled ? 'habilitadas' : 'pausadas'}</strong>${!state.hosting.connected ? ' · conexão ainda não configurada' : ''}. Os bots já publicados são acompanhados independentemente do provedor.</p><div class="health-toolbar"><label>Mostrar nesta página<select data-health-filter><option value="all">Todas as lojas</option><option value="attention">Precisam de atenção</option><option value="connection">Conexão pendente</option><option value="payments">Pagamentos pendentes</option><option value="delivery">Problemas de entrega</option><option value="activation">Ativações pendentes</option></select></label><span>${state.summary.pendingPayments} pagamentos aguardando · ${state.summary.deliveryIssues} pedidos com pendência de entrega</span></div><div class="health-stores">${rows.length ? rows.map((row) => `<article class="health-store"><div class="health-store-heading"><div><h3>${esc(row.storeName)}</h3><p>${row.botUsername ? '@' + esc(row.botUsername) : 'Bot ainda não informado'}</p></div><span class="health-state ${row.connection === 'online' ? 'is-online' : ''}">${esc(labels[row.connection] ?? row.connection)}</span></div><p class="health-meta">Último sinal: ${dates(row.lastSeen)} · Ativação: ${esc(labels[row.activation] ?? row.activation)}${row.access === 'suspended' ? ' · ACESSO SUSPENSO' : ''}</p><div class="health-counts"><span>${row.counts.waitingPayment} aguardando pagamento</span><span>${row.counts.manualReview} comprovantes para o lojista</span><span>${row.counts.deliveryIssues} pendências de entrega</span></div>${row.alerts.length ? `<ul class="health-alerts">${row.alerts.map((alert) => `<li><span class="health-alert-label">${alert.severity === 'attention' ? 'Conferir' : 'Aguardando'}</span><div><b>${esc(alert.title)}</b><p>${esc(alert.detail)}</p>${alert.reference ? `<small>Pedido ${esc(alert.reference)}</small>` : ''}</div></li>`).join('')}</ul>` : '<p class="health-clear">Nenhuma pendência detectada nesta consulta.</p>'}${row.limited ? '<p class="health-limit">Leitura limitada nesta loja. Há mais registros além da amostra; confira a operação antes de concluir que todos foram verificados.</p>' : ''}<button class="quiet" type="button" data-health-store="${row.id}">Conferir loja e ativação</button></article>`).join('') : '<div class="card"><p>Nenhuma loja neste filtro da página atual.</p></div>'}</div><div class="pagination"><button class="quiet" type="button" data-health-previous ${!stack.length || busy ? 'disabled' : ''}>Anterior</button><span>Página ${stack.length + 1} · até 10 lojas por consulta</span><button class="quiet" type="button" data-health-next ${!state.next || busy ? 'disabled' : ''}>Próxima</button></div><section class="card health-billing"><h2>Contratações e renovações</h2><p>Consulta separada das vendas das lojas: até 30 cobranças recentes da Blackout. ${state.billingSampleLimited ? 'Existem cobranças mais antigas fora desta amostra.' : ''}</p>${state.billing.length ? state.billing.map((invoice) => `<article><div><b>${esc(invoice.purpose)} · ${esc(labels[invoice.status] ?? invoice.status)}</b><p>${invoice.amountCents == null ? 'Valor não informado' : (invoice.amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} · ${dates(invoice.createdAt)}</p><small>Cobrança ${esc(invoice.id)}</small>${invoice.attention ? '<p>Requer conferência. Não emita outra cobrança para substituir uma confirmação incerta.</p>' : ''}</div></article>`).join('') : '<p>Nenhuma cobrança pendente na amostra recente.</p>'}</section><p class="health-footnote">Este painel consulta registros e não reenvia produtos, confirma pagamentos, reinicia bots ou executa reembolsos. A consulta é atualizada a cada minuto enquanto esta tela estiver aberta e visível. Não há aviso por e-mail ou Telegram configurado.</p>`
        : '<p role="status">Consultando registros dos bots…</p>'
    }`;
    const select = host.querySelector<HTMLSelectElement>('[data-health-filter]');
    if (select) select.value = filter;
    for (const position of positions) position.el.scrollTop = position.top;
  };
  const load = async () => {
    if (busy) return;
    busy = true;
    error = '';
    if (!state) render();
    try {
      const next = await api<Health>('/admin/health?after=' + encodeURIComponent(cursor));
      if (host.isConnected) state = next;
    } catch (e) {
      error =
        e instanceof Error
          ? e.message
          : 'Não foi possível atualizar. Os dados exibidos podem estar desatualizados.';
    } finally {
      busy = false;
      render();
    }
  };
  host.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    event.stopPropagation();
    if (button.hasAttribute('data-health-refresh')) void load();
    if (button.hasAttribute('data-health-next') && state?.next && !busy) {
      stack.push(cursor);
      cursor = state.next;
      state = null;
      void load();
    }
    if (button.hasAttribute('data-health-previous') && stack.length && !busy) {
      cursor = stack.pop()!;
      state = null;
      void load();
    }
    if (button.dataset.healthStore && !busy)
      void inspect(button.dataset.healthStore).catch(() => {
        error = 'Não foi possível abrir a loja. Atualize e tente novamente.';
        render();
      });
  });
  host.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    if (select.hasAttribute('data-health-filter')) {
      filter = select.value;
      render();
    }
  });
  await load();
  const timer = window.setInterval(() => {
    if (!host.isConnected) {
      window.clearInterval(timer);
      return;
    }
    if (document.visibilityState === 'visible' && !busy) void load();
  }, 60000);
}
