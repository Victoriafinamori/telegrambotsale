type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Withdrawal = {
  id: string;
  amountCents: number;
  destination: string;
  fullDestination?: string;
  status: string;
  createdAt: string;
  feeCents: number | null;
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
  }[];
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
    host.innerHTML = `<p class="feedback" role="status" data-wallet-feedback hidden></p><section class="mc-panel"><h2>Sua carteira Blackout</h2><p>Vendas recebidas pelo Pix automático Blackout. Pagamentos manuais e recebimentos no seu Mercado Pago ficam fora desta carteira.</p><dl class="mc-wallet-balances"><div><dt>Disponível para sacar</dt><dd>${money(state.availableCents)}</dd></div><div><dt>Saldo total</dt><dd>${money(state.balanceCents)}</dd></div><div><dt>Bloqueado por disputas</dt><dd>${money(state.blockedCents)}</dd></div></dl>${!state.enabled ? '<p>Os saques aguardam habilitação pela Blackout. Seu saldo permanece visível.</p>' : !state.active ? '<p>A subconta está inativa. Fale com a Blackout para regularizar.</p>' : ''}${draft ? `<div class="mc-wallet-confirm"><h3>Confira antes de autorizar</h3><p>Débito total da sua carteira: <strong>${money(draft.amountCents)}</strong></p><p>Chave Pix de destino: <strong class="mc-wallet-key">${esc(draft.fullDestination ?? draft.destination)}</strong></p><p>As tarifas da PurinCash são descontadas deste valor. O valor líquido recebido será informado no comprovante.${draft.markupPercent || draft.markupFixedCents ? ` Taxa adicional da subconta: ${esc(draft.markupPercent)}% + ${money(draft.markupFixedCents ?? 0)}.` : ''}</p><p>Ao autorizar, você receberá a confirmação final no Telegram da loja. A solicitação vence em cinco minutos.</p><div class="mc-shortcuts"><button data-wallet-authorize>Autorizar e confirmar no Telegram</button><button class="quiet" data-wallet-cancel>Não, cancelar</button></div></div>` : `<form data-wallet-prepare><h3>Sacar por Pix</h3><p>Informe o valor bruto. As tarifas do provedor saem desse valor, sem débito adicional.</p><label>Valor do saque (R$)<input name="amount" type="number" min="0.01" max="5000" step="0.01" inputmode="decimal" required ${!state.enabled || !state.active || state.availableCents <= 0 ? 'disabled' : ''}></label><label>Tipo da chave Pix<select name="pixType"><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="email">E-mail</option><option value="phone">Celular (+55 e DDD)</option><option value="random">Chave aleatória</option></select></label><label>Chave Pix para receber<input name="pixKey" autocomplete="off" maxlength="200" required></label><button type="submit" ${!state.enabled || !state.active || state.availableCents <= 0 ? 'disabled' : ''}>Conferir saque</button></form>`}</section><section class="mc-panel"><h2>Seus saques</h2>${state.withdrawals.length ? `<div class="mc-wallet-history">${state.withdrawals.map((r) => `<article><h3>${money(r.amountCents)} · ${esc(statuses[r.status] ?? r.status)}</h3><p>${new Date(r.createdAt).toLocaleString('pt-BR')} · ${esc(r.destination)}</p>${r.netAmountCents !== null ? `<p>Líquido: ${money(r.netAmountCents)} · Tarifas: ${money(r.feeCents ?? 0)}</p>` : ''}<p>${esc(r.message)} ${esc(r.code)}</p>${['prepared', 'awaiting_confirmation'].includes(r.status) ? `<button class="quiet" data-wallet-review="${r.id}">Conferir solicitação</button>` : r.status === 'processing' ? `<button class="quiet" data-wallet-status="${r.id}">Atualizar andamento</button>` : ''}</article>`).join('')}</div>` : '<p>Nenhum saque solicitado.</p>'}</section><section class="mc-panel"><h2>Últimas movimentações</h2>${state.transactions.length ? `<ul class="mc-wallet-movements">${state.transactions.map((t) => `<li><span>${esc(t.description || t.type)}<small>${new Date(t.createdAt).toLocaleString('pt-BR')}</small></span><strong>${money(t.amountCents)}</strong></li>`).join('')}</ul>` : '<p>As vendas confirmadas, saques e devoluções aparecerão aqui.</p>'}</section>`;
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
      if (button.hasAttribute('data-wallet-authorize') && draft) {
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
