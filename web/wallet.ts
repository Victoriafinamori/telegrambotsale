import './wallet.css';
type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Withdrawal = {
  id: string;
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
  ])}${r.status === 'reversed' ? `<p class="wallet-status-note">O provedor confirmou a devolução do valor integral de ${money(r.amountCents)}, incluindo as taxas. O extrato registra o crédito de retorno.</p>` : r.status === 'processing' ? '<p class="wallet-status-note">A confirmação ainda não terminou. Não solicite novamente este mesmo valor.</p>' : ''}<ol class="wallet-timeline" aria-label="Andamento do saque"><li>Solicitação criada <time>${date(r.createdAt)}</time></li><li>${r.status === 'prepared' ? 'Aguardando sua autorização no site' : r.status === 'awaiting_confirmation' ? 'Aguardando confirmação no Telegram' : r.submittedAt ? `Solicitação enviada para conferência do provedor<time>${date(r.submittedAt)}</time>` : esc(statuses[r.status] ?? r.status)}</li>${r.status === 'completed' ? `<li>Pix confirmado pelo banco${r.completedAt ? `<time>${date(r.completedAt)}</time>` : ''}</li>` : r.status === 'reversed' ? `<li>Saldo devolvido${r.reversedAt ? `<time>${date(r.reversedAt)}</time>` : ''}</li>` : ''}</ol>`;
const statuses: Record<string, string> = {
  prepared: 'Confira os dados',
  awaiting_confirmation: 'Confirme no Telegram',
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
    busy = false;
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
    host.innerHTML = `<p class="feedback" role="status" data-wallet-feedback hidden></p><section class="mc-panel"><div class="wallet-heading"><h2>Sua carteira Blackout</h2><button type="button" class="quiet" data-wallet-refresh>Atualizar carteira</button></div><p>Vendas recebidas pelo Pix automático Blackout. Pagamentos manuais e recebimentos no seu Mercado Pago ficam fora desta carteira.</p><dl class="mc-wallet-balances"><div><dt>Disponível para sacar</dt><dd>${money(state.availableCents)}</dd></div><div><dt>Saldo total</dt><dd>${money(state.balanceCents)}</dd></div><div><dt>Bloqueado por disputas</dt><dd>${money(state.blockedCents)}</dd></div></dl><p class="wallet-explainer">O saldo total inclui o valor bloqueado. Disponível é o valor que a Purin informa como liberado para saque; as tarifas do saque ainda serão descontadas do valor solicitado.</p><p class="wallet-updated">Saldo consultado em ${date(state.checkedAt)}.</p>${!state.enabled ? '<p>Os saques aguardam habilitação pela Blackout. Seu saldo permanece visível.</p>' : !state.active ? '<p>A subconta está inativa. Fale com a Blackout para regularizar.</p>' : ''}${draft ? `<div class="mc-wallet-confirm"><h3>Confira antes de autorizar</h3><p>Débito total da sua carteira: <strong>${money(draft.amountCents)}</strong></p><p>Chave Pix de destino: <strong class="mc-wallet-key">${esc(draft.fullDestination ?? draft.destination)}</strong></p><p>O valor solicitado já inclui as tarifas; não há débito adicional. Tarifa Purin: confirmada no resultado do saque. Taxa Blackout configurada nesta solicitação: ${esc(draft.markupPercent ?? 0)}% + ${money(draft.markupFixedCents ?? 0)}. O valor efetivamente cobrado e o líquido são exibidos quando o provedor os informar.</p><p>Ao autorizar, você receberá a confirmação final no Telegram da loja. A solicitação vence em cinco minutos.</p><div class="mc-shortcuts"><button data-wallet-authorize>Autorizar e confirmar no Telegram</button><button class="quiet" data-wallet-cancel>Não, cancelar</button></div></div>` : `<form data-wallet-prepare><h3>Sacar por Pix</h3><p>Informe o valor bruto. As tarifas do provedor saem desse valor, sem débito adicional.</p><label>Valor do saque (R$)<input name="amount" type="number" min="0.01" max="5000" step="0.01" inputmode="decimal" required ${!state.enabled || !state.active || state.availableCents <= 0 ? 'disabled' : ''}></label><label>Tipo da chave Pix<select name="pixType"><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="email">E-mail</option><option value="phone">Celular (+55 e DDD)</option><option value="random">Chave aleatória</option></select></label><label>Chave Pix para receber<input name="pixKey" autocomplete="off" maxlength="200" required></label><button type="submit" ${!state.enabled || !state.active || state.availableCents <= 0 ? 'disabled' : ''}>Conferir saque</button></form>`}</section><section class="mc-panel"><h2>Seus saques</h2>${state.withdrawals.length ? `<div class="mc-wallet-history">${state.withdrawals.map((r) => `<article><h3>${money(r.amountCents)} · ${esc(statuses[r.status] ?? r.status)}</h3><p>${new Date(r.createdAt).toLocaleString('pt-BR')} · ${esc(r.destination)}</p>${withdrawalDetail(r)}<p>${esc(r.message)} ${esc(r.code)}</p>${['prepared', 'awaiting_confirmation'].includes(r.status) ? `<button class="quiet" data-wallet-review="${r.id}">Conferir solicitação</button>` : ['processing', 'completed'].includes(r.status) ? `<button class="quiet" data-wallet-status="${r.id}">Atualizar andamento</button>` : ''}</article>`).join('')}</div>` : '<p>Nenhum saque solicitado.</p>'}</section><section class="mc-panel"><h2>Extrato detalhado</h2><p class="wallet-explainer">Últimas 20 movimentações da subconta. Os créditos de vendas já chegam líquidos; saques e devoluções são lançamentos separados. Este recorte não representa todo o histórico.</p>${
      state.transactions.length
        ? `<ul class="mc-wallet-movements">${state.transactions
            .map(
              (t) =>
                `<li class="wallet-movement"><div class="wallet-movement-heading"><span><b>${esc(movementLabels[t.type] ?? t.type)}</b><small>${date(t.createdAt)}</small></span><strong>${t.amountCents > 0 ? '+' : ''}${money(t.amountCents)}</strong></div>${t.orderId ? `<p>Pedido ${esc(t.orderId)}</p>` : ''}${t.description ? `<p class="wallet-description">${esc(t.description)}</p>` : ''}${
                  t.breakdown
                    ? `${breakdown([
                        ['Valor bruto da venda', t.breakdown.grossCents],
                        ['Tarifa Purin', t.breakdown.gatewayFeeCents],
                        ['Taxa Blackout', t.breakdown.blackoutFeeCents],
                        ['Líquido creditado na carteira', t.breakdown.netCents],
                      ])}<p class="wallet-status-note">${t.breakdown.reconciled ? 'Bruto − tarifa Purin − taxa Blackout = líquido creditado.' : 'Detalhamento incompleto ou em conferência. O crédito acima é o lançamento do provedor; valores ausentes não são considerados zero.'}</p>`
                    : ''
                }<details><summary>Referência da movimentação</summary><p class="wallet-reference">${esc(t.reference || t.id)}</p></details></li>`,
            )
            .join('')}</ul>`
        : '<p>As vendas confirmadas, saques e devoluções aparecerão aqui.</p>'
    }</section>`;
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
        pixType: String(fields.get('pixType')),
        pixKey: String(fields.get('pixKey')).trim(),
      });
      await load();
      render();
    });
  });
  host.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    event.stopPropagation();
    void work(async () => {
      if (button.hasAttribute('data-wallet-refresh')) {
        await load();
        render();
      } else if (button.hasAttribute('data-wallet-authorize') && draft) {
        await api('/store/manage/wallet/approve', { draftId: draft.id });
        draft = null;
        await load();
        render();
        feedback(
          'Autorização registrada. Abra o Telegram da loja e toque em Confirmar saque para enviar.',
        );
      } else if (button.hasAttribute('data-wallet-cancel') && draft) {
        await api('/store/manage/wallet/cancel', { draftId: draft.id });
        draft = null;
        await load();
        render();
        feedback('Saque cancelado antes do envio.');
      } else if (button.dataset.walletReview) {
        draft = await api<Withdrawal>('/store/manage/wallet/drafts/' + button.dataset.walletReview);
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
    render();
  } catch (error) {
    if (host.isConnected)
      host.innerHTML = `<section class="mc-panel"><h2>Carteira</h2><p role="alert">${esc(error instanceof Error ? error.message : 'Carteira temporariamente indisponível.')}</p></section>`;
  }
}
