import './wallet.css';
type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Withdrawal = {
  id: string;
  channel: 'web' | 'telegram';
  estimatedBlackoutFeeCents: number;
  amountCents: number;
  destination: string;
  fullDestination?: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  feeCents: number | null;
  gatewayFeeCents: number | null;
  blackoutFeeCents: number | null;
  completedAt: string | null;
  reversedAt: string | null;
  updatedAt: string;
  netAmountCents: number | null;
  message: string;
  code: string;
  markupPercent?: number;
  markupFixedCents?: number;
};
type Wallet = {
  keys: { id: string; type: string; label: string; destination: string }[];
  salePercent: number;
  saleFixedCents: number;
  balanceCents: number;
  availableCents: number;
  blockedCents: number;
  checkedAt: string;
  totalReceivedCents: number | null;
  enabled: boolean;
  active: boolean;
  markupPercent: number;
  markupFixedCents: number;
  withdrawals: Withdrawal[];
  transactions: {
    id: string;
    type: string;
    amountCents: number;
    description: string;
    createdAt: string;
    reference: string;
    orderId: string | null;
    breakdown: {
      grossCents: number | null;
      netCents: number | null;
      blackoutFeeCents: number | null;
      gatewayFeeCents: number | null;
      reconciled: boolean;
    } | null;
  }[];
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const amount = (value: number | null | undefined) =>
  value == null ? '<span class="wallet-unknown">Não informado</span>' : money(value);
const date = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('pt-BR')
    : 'Sem data informada';
const movementLabels: Record<string, string> = {
  sale: 'Venda confirmada',
  payout: 'Saque',
  payout_reversal: 'Devolução de saque',
  transfer_in: 'Crédito por transferência',
  transfer_out: 'Débito por transferência',
  adjust: 'Ajuste de saldo',
};
const breakdown = (rows: [string, number | null | undefined][]) =>
  `<dl class="wallet-breakdown">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${amount(value)}</dd></div>`).join('')}</dl>`;
const withdrawalDetail = (r: Withdrawal) =>
  `${breakdown([
    ['Débito solicitado da carteira', r.amountCents],
    ['Tarifa Purin', r.gatewayFeeCents],
    ['Taxa Blackout', r.blackoutFeeCents],
    ['Total de tarifas', r.feeCents],
    ['Líquido destinado ao Pix', r.netAmountCents],
  ])}${r.status === 'reversed' ? `<p class="wallet-status-note">O provedor confirmou a devolução do valor integral de ${money(r.amountCents)}, incluindo as taxas. O extrato registra o crédito de retorno.</p>` : r.status === 'processing' ? '<p class="wallet-status-note">A confirmação ainda não terminou. Não solicite novamente este mesmo valor.</p>' : ''}<ol class="wallet-timeline" aria-label="Andamento do saque"><li>Solicitação criada <time>${date(r.createdAt)}</time></li><li>${r.status === 'prepared' ? 'Aguardando confirmação no canal de origem' : r.status === 'awaiting_confirmation' ? 'Aguardando confirmação no Telegram' : r.submittedAt ? `Solicitação enviada para conferência do provedor<time>${date(r.submittedAt)}</time>` : esc(statuses[r.status] ?? r.status)}</li>${r.status === 'completed' ? `<li>Pix confirmado pelo banco${r.completedAt ? `<time>${date(r.completedAt)}</time>` : ''}</li>` : r.status === 'reversed' ? `<li>Saldo devolvido${r.reversedAt ? `<time>${date(r.reversedAt)}</time>` : ''}</li>` : ''}</ol>`;
const statuses: Record<string, string> = {
  prepared: 'Confira os dados',
  awaiting_confirmation: 'Aguardando confirmação',
  processing: 'Em processamento',
  completed: 'Concluído',
  failed: 'Recusado',
  reversed: 'Saldo devolvido',
  cancelled: 'Cancelado',
  expired: 'Solicitação vencida',
};
export async function mountWallet(host: HTMLElement, api: Api) {
  let state: Wallet,
    draft: Withdrawal | null = null,
    busy = false,
    tab = 'withdrawals',
    filter = 'all',
    showWithdraw = false,
    showKeyForm = false;
  const feedback = (text: string) => {
    const el = host.querySelector<HTMLElement>('[data-wallet-feedback]');
    if (el) {
      el.hidden = false;
      el.textContent = text;
    }
  };
  const load = async () => {
    state = await api<Wallet>('/store/manage/wallet');
  };
  const render = () => {
    if (!host.isConnected) return;
    const canWithdraw = state.enabled && state.active && state.availableCents > 0;
    const rows = state.withdrawals.filter(
      (r) =>
        filter === 'all' ||
        (filter === 'pending'
          ? ['prepared', 'awaiting_confirmation', 'processing'].includes(r.status)
          : r.status === filter),
    );
    host.innerHTML = `<div class="wallet-page"><p class="feedback" role="status" data-wallet-feedback hidden></p>
      <header class="wallet-heading"><div><p class="wallet-eyebrow">FINANCEIRO / CARTEIRA</p><h2>Seu dinheiro, com clareza.</h2><p>Saldo disponível, chaves Pix e cada movimentação da sua loja.</p></div><button type="button" class="quiet" data-wallet-refresh>↻ Atualizar</button></header>
      <div class="wallet-cards">
        <article class="wallet-card wallet-card-available"><span>Saldo disponível <span aria-hidden="true">↗</span></span><strong>${money(state.availableCents)}</strong><small>Pronto para transferir por Pix</small><button data-wallet-open ${!canWithdraw ? 'disabled' : ''}>↑ Sacar agora</button></article>
        <article class="wallet-card"><span>Saldo total <span aria-hidden="true">◷</span></span><strong>${money(state.balanceCents)}</strong><small>Inclui valores bloqueados por disputas</small></article>
        <article class="wallet-card"><span>Em disputa <span aria-hidden="true">◇</span></span><strong>${money(state.blockedCents)}</strong><small>${state.blockedCents ? 'Aguardando resolução pelo provedor' : 'Nenhum valor bloqueado'}</small></article>
      </div>
      <div class="wallet-fees"><span><b>${esc(state.salePercent)}%${state.saleFixedCents ? ' + ' + money(state.saleFixedCents) : ''}</b> comissão Blackout por venda</span><span><b>${state.markupPercent ? esc(state.markupPercent) + '% + ' : ''}${money(state.markupFixedCents)}</b> taxa Blackout por saque</span><p>Tarifas Purin são adicionais. A comissão sobre vendas é calculada após a tarifa do provedor. O extrato preserva as taxas de cada venda.</p></div>
      <p class="wallet-updated">Atualizado em ${date(state.checkedAt)}${!state.enabled ? ' · Saques aguardam habilitação pela Blackout.' : !state.active ? ' · Subconta inativa. Fale com a Blackout.' : ''}</p>
      <nav class="wallet-tabs" aria-label="Informações da carteira">${[
        ['withdrawals', 'Saques'],
        ['transactions', 'Extrato'],
        ['keys', 'Chaves Pix'],
      ]
        .map(
          ([id, label]) =>
            `<button data-wallet-tab="${id}" aria-pressed="${tab === id}">${label}${id === 'withdrawals' ? ' <small>' + state.withdrawals.length + '</small>' : ''}</button>`,
        )
        .join('')}</nav>
      <section class="wallet-section">
      ${
        tab === 'withdrawals'
          ? `<div class="wallet-heading"><div><h3>Histórico de saques</h3><p>Confira o destino, as taxas e o andamento.</p></div><div class="wallet-filters" aria-label="Filtrar saques">${[
              ['all', 'Todos'],
              ['completed', 'Concluídos'],
              ['pending', 'Pendentes'],
              ['failed', 'Recusados'],
            ]
              .map(
                ([id, label]) =>
                  `<button data-wallet-filter="${id}" aria-pressed="${filter === id}">${label}</button>`,
              )
              .join('')}</div></div>
      ${rows.length ? `<div class="wallet-table-scroll"><table class="wallet-table"><thead><tr><th>Pedido / data</th><th>Destino Pix</th><th>Solicitado</th><th>Taxas</th><th>Líquido recebido</th><th>Status</th><th>Detalhes</th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${esc(r.code || '#' + r.id.slice(0, 8))}</b><small>${date(r.createdAt)}</small></td><td>${esc(r.destination)}</td><td>${money(r.amountCents)}</td><td>${amount(r.feeCents)}</td><td>${amount(r.netAmountCents)}</td><td><span class="wallet-badge wallet-badge-${esc(r.status)}">${esc(statuses[r.status] ?? r.status)}</span></td><td><details><summary>Ver detalhes</summary>${withdrawalDetail(r)}<p>${esc(r.message)}</p>${['prepared', 'awaiting_confirmation'].includes(r.status) ? (r.channel === 'telegram' ? '<p>Continue no Telegram, onde você iniciou este saque.</p>' : `<button class="quiet" data-wallet-review="${r.id}">Conferir e confirmar</button>`) : ['processing', 'completed'].includes(r.status) ? `<button class="quiet" data-wallet-status="${r.id}">Atualizar andamento</button>` : ''}</details></td></tr>`).join('')}</tbody></table></div>` : '<div class="wallet-empty"><span aria-hidden="true">↗</span><h3>Nenhum saque por aqui</h3><p>Seus saques aparecerão aqui com todas as taxas e o valor recebido.</p></div>'}`
          : tab === 'keys'
            ? `<div class="wallet-heading"><div><h3>Suas chaves Pix</h3><p>Salvas com segurança para facilitar os próximos saques.</p></div><button data-wallet-add-key>${showKeyForm ? 'Fechar cadastro' : '+ Adicionar chave'}</button></div>${showKeyForm ? `<form class="wallet-key-form" data-wallet-key><label>Nome da chave<input name="label" maxlength="40" placeholder="Ex.: Minha conta principal"></label><label>Tipo<select name="pixType"><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="email">E-mail</option><option value="phone">Celular (+55 e DDD)</option><option value="random">Aleatória</option></select></label><label>Chave Pix<input name="pixKey" maxlength="200" required autocomplete="off"></label><button>Salvar chave</button></form>` : ''}<div class="wallet-key-list">${state.keys.length ? state.keys.map((k) => `<article><span aria-hidden="true">◇</span><div><b>${esc(k.label)}</b><small>${esc(k.type.toUpperCase())} · ${esc(k.destination)}</small></div><button class="quiet" data-wallet-remove-key="${k.id}" aria-label="Remover ${esc(k.label)}">Remover</button></article>`).join('') : '<p class="wallet-empty">Nenhuma chave salva. Adicione uma para usar nos próximos saques.</p>'}</div>`
            : `<div class="wallet-heading"><div><h3>Extrato da carteira</h3><p>Últimas 20 movimentações. Créditos de vendas já chegam líquidos.</p></div></div>${
                state.transactions.length
                  ? `<ul class="mc-wallet-movements">${state.transactions
                      .map(
                        (t) =>
                          `<li class="wallet-movement"><div class="wallet-movement-heading"><span><b>${esc(movementLabels[t.type] ?? t.type)}</b><small>${date(t.createdAt)}</small></span><strong>${t.amountCents > 0 ? '+' : ''}${money(t.amountCents)}</strong></div><details><summary>Ver composição do valor</summary>${t.orderId ? `<p>Pedido #${esc(t.orderId)}</p>` : ''}${
                            t.breakdown
                              ? breakdown([
                                  ['Valor da venda', t.breakdown.grossCents],
                                  ['Tarifa Purin', t.breakdown.gatewayFeeCents],
                                  ['Comissão Blackout', t.breakdown.blackoutFeeCents],
                                  ['Líquido creditado', t.breakdown.netCents],
                                ]) +
                                `<p class="wallet-status-note">${t.breakdown.reconciled ? 'Valores conferidos com o crédito do provedor.' : 'Detalhamento em conferência; valores ausentes não são considerados zero.'}</p>`
                              : `<p>${esc(t.description)}</p>`
                          }<p class="wallet-reference">${esc(t.reference || t.id)}</p></details></li>`,
                      )
                      .join('')}</ul>`
                  : '<div class="wallet-empty"><h3>Seu extrato começa com a primeira venda</h3><p>Vendas, saques e devoluções aparecerão aqui.</p></div>'
              }`
      }</section>
      ${
        showWithdraw
          ? `<div class="wallet-modal-backdrop"><section class="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title"><div class="wallet-heading"><h3 id="wallet-dialog-title">${draft ? 'Confira seu saque' : 'Sacar por Pix'}</h3><button class="quiet" data-wallet-close aria-label="Fechar saque">✕</button></div>${
              draft
                ? draft.channel === 'telegram'
                  ? '<p>Este saque foi iniciado no Telegram. Confirme por lá.</p>'
                  : `<p>Chave de destino</p><strong class="mc-wallet-key">${esc(draft.fullDestination ?? draft.destination)}</strong>${breakdown(
                      [
                        ['Débito da carteira', draft.amountCents],
                        ['Taxa Blackout', draft.estimatedBlackoutFeeCents],
                        [
                          'Após taxa Blackout',
                          Math.max(0, draft.amountCents - draft.estimatedBlackoutFeeCents),
                        ],
                      ],
                    )}<p class="wallet-status-note">A tarifa Purin ainda será descontada pelo provedor. O líquido final aparecerá no comprovante. A solicitação vence em cinco minutos.</p><div class="wallet-actions"><button data-wallet-authorize>Confirmar saque neste site</button><button class="quiet" data-wallet-cancel>Cancelar solicitação</button></div>`
                : `<p>Disponível: <b>${money(state.availableCents)}</b></p><form data-wallet-prepare><label>Valor a debitar da carteira (R$)<input name="amount" type="number" min="0.01" max="${Math.min(state.availableCents, 500000) / 100}" step="0.01" inputmode="decimal" required></label><div data-wallet-estimate></div><p class="wallet-status-note">A taxa Blackout e a tarifa Purin saem do valor solicitado. Nenhum valor adicional será debitado.</p><label>Receber em<select name="savedKeyId"><option value="">Usar outra chave</option>${state.keys.map((k) => `<option value="${k.id}">${esc(k.label)} · ${esc(k.destination)}</option>`).join('')}</select></label><fieldset data-wallet-new-key><label>Tipo<select name="pixType"><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="email">E-mail</option><option value="phone">Celular (+55 e DDD)</option><option value="random">Chave aleatória</option></select></label><label>Chave Pix<input name="pixKey" maxlength="200" autocomplete="off" required></label></fieldset><button type="submit">Conferir saque →</button></form>`
            }</section></div>`
          : ''
      }</div>`;
  };
  const work = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).map(
      (button) => ({ button, disabled: button.disabled }),
    );
    buttons.forEach(({ button }) => (button.disabled = true));
    try {
      await fn();
    } catch (error) {
      feedback(error instanceof Error ? error.message : 'Não foi possível acessar a carteira.');
    } finally {
      busy = false;
      buttons
        .filter(({ button }) => button.isConnected)
        .forEach(({ button, disabled }) => (button.disabled = disabled));
    }
  };
  host.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target as HTMLFormElement;
    if (form.hasAttribute('data-wallet-key')) {
      void work(async () => {
        await api('/store/manage/wallet/keys', Object.fromEntries(new FormData(form)));
        showKeyForm = false;
        await load();
        render();
        feedback('Chave Pix salva.');
      });
      return;
    }
    if (!form.hasAttribute('data-wallet-prepare')) return;
    void work(async () => {
      const fields = new FormData(form),
        value = String(fields.get('amount') ?? '');
      if (!/^\d+(?:[.,]\d{1,2})?$/.test(value))
        throw Error('Informe o valor em reais com até duas casas decimais.');
      const amountCents = Math.round(Number(value.replace(',', '.')) * 100);
      draft = await api<Withdrawal>('/store/manage/wallet/prepare', {
        requestId: crypto.randomUUID(),
        amountCents,
        ...(fields.get('savedKeyId')
          ? { savedKeyId: String(fields.get('savedKeyId')) }
          : {
              pixType: String(fields.get('pixType')),
              pixKey: String(fields.get('pixKey')).trim(),
            }),
      });
      await load();
      render();
    });
  });
  host.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name !== 'amount') return;
    const n = Math.round(Number(input.value) * 100),
      fee = Math.floor((n * state.markupPercent) / 100) + state.markupFixedCents;
    const summary = host.querySelector('[data-wallet-estimate]');
    if (summary)
      summary.innerHTML = breakdown([
        ['Valor solicitado', Number.isFinite(n) ? n : 0],
        ['Taxa Blackout', fee],
        ['Após taxa Blackout', Math.max(0, n - fee)],
      ]);
  });
  host.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    if (select.name !== 'savedKeyId') return;
    const fields = host.querySelector<HTMLFieldSetElement>('[data-wallet-new-key]');
    if (fields) {
      fields.hidden = !!select.value;
      fields.disabled = !!select.value;
    }
  });
  host.addEventListener('keydown', (event) => {
    if (!showWithdraw) return;
    if (event.key === 'Escape' && !busy) {
      showWithdraw = false;
      draft = null;
      render();
      host.querySelector<HTMLButtonElement>('[data-wallet-open]')?.focus();
    }
    if (event.key === 'Tab') {
      const nodes = Array.from(
        host.querySelectorAll<HTMLElement>(
          '.wallet-modal button:not(:disabled), .wallet-modal input:not(:disabled), .wallet-modal select:not(:disabled)',
        ),
      ).filter((n) => n.getClientRects().length);
      const first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  host.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    event.stopPropagation();
    void work(async () => {
      if (button.hasAttribute('data-wallet-open')) {
        showWithdraw = true;
        draft = null;
        render();
        host.querySelector<HTMLInputElement>('[name="amount"]')?.focus();
      } else if (button.hasAttribute('data-wallet-close')) {
        showWithdraw = false;
        draft = null;
        render();
      } else if (button.dataset.walletTab) {
        tab = button.dataset.walletTab;
        render();
      } else if (button.dataset.walletFilter) {
        filter = button.dataset.walletFilter;
        render();
      } else if (button.hasAttribute('data-wallet-add-key')) {
        showKeyForm = !showKeyForm;
        render();
      } else if (button.dataset.walletRemoveKey) {
        await api('/store/manage/wallet/keys/remove', { keyId: button.dataset.walletRemoveKey });
        await load();
        render();
        feedback('Chave Pix removida.');
      } else if (button.hasAttribute('data-wallet-refresh')) {
        await load();
        render();
      } else if (button.hasAttribute('data-wallet-authorize') && draft) {
        const result = await api<Withdrawal>('/store/manage/wallet/approve', { draftId: draft.id });
        draft = null;
        showWithdraw = false;
        await load();
        render();
        feedback(result.message || 'Saque enviado. Acompanhe o resultado no histórico.');
      } else if (button.hasAttribute('data-wallet-cancel') && draft) {
        await api('/store/manage/wallet/cancel', { draftId: draft.id });
        draft = null;
        await load();
        render();
        feedback('Saque cancelado antes do envio.');
      } else if (button.dataset.walletReview) {
        draft = await api<Withdrawal>('/store/manage/wallet/drafts/' + button.dataset.walletReview);
        showWithdraw = true;
        render();
        host.querySelector('h3')?.scrollIntoView({ block: 'center' });
      } else if (button.dataset.walletStatus) {
        await api('/store/manage/wallet/status', { draftId: button.dataset.walletStatus });
        await load();
        render();
      }
    });
  });
  try {
    await load();
    const wid = new URLSearchParams(location.hash.split('?')[1] ?? '').get('wallet');
    if (wid && /^[a-f0-9-]{36}$/.test(wid))
      draft = await api<Withdrawal>('/store/manage/wallet/drafts/' + wid);
    showWithdraw = !!draft;
    render();
  } catch (error) {
    if (host.isConnected)
      host.innerHTML = `<section class="mc-panel"><h2>Carteira</h2><p role="alert">${esc(error instanceof Error ? error.message : 'Carteira temporariamente indisponível.')}</p></section>`;
  }
}
