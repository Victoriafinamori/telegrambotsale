type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Plan = { id: string; label: string; months: number; priceCents: number; enabled: boolean };
type Invoice = {
  id: string;
  label: string;
  months: number;
  total: number;
  status: string;
  expiresAt: string;
  paidThrough: string | null;
  qrCode: string;
};
type Subscription = {
  plans: Plan[];
  paidThrough: string | null;
  months: number;
  canRenew: boolean;
  invoice: Invoice | null;
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const date = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'Aguardando ativação';
export async function mountSubscription(host: HTMLElement, api: Api) {
  let data: Subscription,
    selected: Plan | undefined,
    busy = false;
  const render = async () => {
    if (!host.isConnected) return;
    const invoice = data.invoice,
      open =
        invoice &&
        ['creating', 'uncertain', 'awaiting_payment'].includes(invoice.status) &&
        (!invoice.expiresAt ||
          new Date(invoice.expiresAt) > new Date() ||
          invoice.status !== 'awaiting_payment');
    host.innerHTML = `<section class="mc-panel"><h2>Sua assinatura Blackout</h2><p>Vencimento atual: <strong>${esc(date(data.paidThrough))}</strong></p><p>Renove por 1, 3 ou 12 meses. Se o plano ainda estiver válido, os dias restantes são preservados. Se venceu, o novo período começa após a confirmação.</p>${!data.canRenew ? '<p class="note">A renovação fica disponível após a ativação. O plano inicial é definido na contratação com a Blackout.</p>' : ''}<div class="mc-subscription-plans">${data.plans.map((p) => `<article class="mc-subscription-plan"><h3>${esc(p.label)}</h3><p><strong>${money(p.priceCents)}</strong><span> por ${p.months} ${p.months === 1 ? 'mês' : 'meses'}</span></p><button data-choose-plan="${p.id}" ${!data.canRenew || !p.enabled || open ? 'disabled' : ''}>Escolher ${esc(p.label.toLowerCase())}</button></article>`).join('')}</div><p class="note">Pagamento único por Pix para o período escolhido. Não há débito automático de novas renovações.</p></section>${selected && !open ? `<section class="mc-panel"><h2>Conferir renovação</h2><p>Plano <strong>${esc(selected.label)}</strong>: ${selected.months} mês(es), por <strong>${money(selected.priceCents)}</strong>.</p><p>O Pix renova apenas a sua assinatura Blackout. O saldo da carteira da loja não será usado.</p><div class="mc-shortcuts"><button data-generate-subscription>Gerar Pix de ${money(selected.priceCents)}</button><button class="quiet" data-back-plans>Voltar</button></div></section>` : ''}${invoice ? `<section class="mc-panel" aria-label="Pagamento da assinatura"><h2>${invoice.status === 'paid' ? 'Renovação confirmada' : invoice.status === 'review_required' ? 'Pagamento em conferência' : 'Seu Pix de renovação'}</h2><p>${esc(invoice.label)} · ${invoice.months} mês(es) · <strong>${money(invoice.total)}</strong></p>${invoice.status === 'paid' ? `<p>Seu acesso foi renovado até ${esc(date(invoice.paidThrough))}.</p>` : invoice.status === 'review_required' ? '<p>O pagamento precisa de conferência da Blackout. Não pague novamente. Fale com o atendimento e informe o número desta cobrança.</p>' : invoice.qrCode && open ? `<div class="pix-qr" data-subscription-qr></div><label>Pix copia e cola<textarea readonly rows="4" data-subscription-code>${esc(invoice.qrCode)}</textarea></label><div class="mc-shortcuts"><button data-copy-subscription>Copiar Pix</button><button class="quiet" data-check-subscription>Verificar pagamento</button></div><p>Válido até ${esc(date(invoice.expiresAt))}. Confira o valor e o recebedor no seu banco. A confirmação renova o plano automaticamente.</p>` : ['creating', 'uncertain'].includes(invoice.status) ? '<p>A geração está em conferência. Não gere outra cobrança nem pague duas vezes. Use Verificar pagamento.</p><button class="quiet" data-check-subscription>Verificar pagamento</button>' : '<p>Esta cobrança não está disponível para pagamento. Atualize os planos para continuar.</p>'}<small>Cobrança ${esc(invoice.id)}</small></section>` : ''}<p role="status" data-subscription-feedback hidden></p>`;
    if (invoice?.qrCode && open) {
      const QR = (await import('qrcode')).default;
      const src = await QR.toDataURL(invoice.qrCode, { width: 256, margin: 4 });
      const target = host.querySelector('[data-subscription-qr]');
      if (target) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'QR Code Pix para renovar sua assinatura Blackout';
        target.append(img);
      }
    }
  };
  const refresh = async () => {
    data = await api<Subscription>('/store/subscription');
    await render();
  };
  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    const states = new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button'), (b) => [b, b.disabled]),
    );
    states.forEach((_was, b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      const el = host.querySelector<HTMLElement>('[data-subscription-feedback]');
      if (el) {
        el.hidden = false;
        el.textContent =
          e instanceof Error ? e.message : 'Não foi possível concluir. Atualize a página.';
      }
    } finally {
      busy = false;
      states.forEach((was, b) => {
        if (b.isConnected) b.disabled = was;
      });
    }
  };
  host.addEventListener('click', (event) => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || busy) return;
    if (b.dataset.choosePlan) {
      selected = data.plans.find((p) => p.id === b.dataset.choosePlan);
      void render();
    } else if (b.hasAttribute('data-back-plans')) {
      selected = undefined;
      void render();
    } else if (b.hasAttribute('data-generate-subscription') && selected) {
      void action(async () => {
        data.invoice = await api<Invoice>('/store/subscription/create', {
          plan: selected!.id,
          expectedPriceCents: selected!.priceCents,
          requestId: crypto.randomUUID(),
        });
        selected = undefined;
        await render();
      });
    } else if (b.hasAttribute('data-check-subscription') && data.invoice) {
      void action(async () => {
        await api('/store/subscription/check', { invoiceId: data.invoice!.id });
        await refresh();
      });
    } else if (b.hasAttribute('data-copy-subscription') && data.invoice?.qrCode) {
      void action(async () => {
        await navigator.clipboard.writeText(data.invoice!.qrCode);
        const el = host.querySelector<HTMLElement>('[data-subscription-feedback]');
        if (el) {
          el.hidden = false;
          el.textContent = 'Pix copiado.';
        }
      });
    }
  });
  try {
    await refresh();
  } catch (e) {
    host.innerHTML = `<p role="alert">${esc(e instanceof Error ? e.message : 'Assinatura indisponível.')}</p>`;
    return;
  }
  const timer = window.setInterval(() => {
    if (!host.isConnected) {
      clearInterval(timer);
      return;
    }
    if (
      !busy &&
      !selected &&
      data.invoice &&
      ['creating', 'uncertain', 'awaiting_payment'].includes(data.invoice.status) &&
      document.visibilityState === 'visible'
    )
      void api<Subscription>('/store/subscription')
        .then((next) => {
          if (JSON.stringify(next) !== JSON.stringify(data)) {
            data = next;
            void render();
          }
        })
        .catch(() => {});
  }, 15000);
}
export async function mountSubscriptionAdmin(host: HTMLElement, api: Api, accountId?: string) {
  type Settings = { revision: number; plans: Plan[] };
  let data: Settings;
  const render = () => {
    host.innerHTML = `<h2>${accountId ? 'Plano inicial da contratação' : 'Planos de assinatura Blackout'}</h2><p>${accountId ? 'Escolha o período antes de ativar o bot. O tempo contratado começa somente na ativação.' : 'Defina o preço total de cada período. Alterações valem para novas cobranças; Pix já emitidos mantêm o preço original.'}</p><form data-subscription-settings>${accountId ? `<label>Plano<select name="plan">${data.plans.map((p) => `<option value="${p.id}">${esc(p.label)} · ${p.months} mês(es) · ${money(p.priceCents)}</option>`).join('')}</select></label>` : `<div class="mc-form-row">${data.plans.map((p) => `<label>${esc(p.label)} · ${p.months} mês(es)<input name="${p.id}" type="number" min="0.01" max="100000" step="0.01" value="${(p.priceCents / 100).toFixed(2)}" required></label>`).join('')}</div>`}<button type="submit">${accountId ? 'Definir plano inicial' : 'Salvar preços dos planos'}</button></form><p role="status" data-plan-feedback hidden></p>`;
  };
  try {
    data = await api<Settings>('/admin/subscription-plans');
    render();
  } catch (e) {
    host.innerHTML = `<p role="alert">${esc(e instanceof Error ? e.message : 'Planos indisponíveis.')}</p>`;
    return;
  }
  host.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-subscription-settings]')) return;
    const button = form.querySelector<HTMLButtonElement>('button')!;
    if (button.disabled) return;
    button.disabled = true;
    const fields = new FormData(form);
    void (async () => {
      const message = host.querySelector<HTMLElement>('[data-plan-feedback]')!;
      try {
        if (accountId) {
          await api('/admin/accounts/' + accountId + '/subscription-plan', {
            plan: fields.get('plan'),
          });
        } else {
          const prices = Object.fromEntries(
            data.plans.map((p) => [p.id, Math.round(Number(fields.get(p.id)) * 100)]),
          );
          data = await api<Settings>('/admin/subscription-plans', {
            revision: data.revision,
            prices,
          });
        }
        message.textContent = accountId
          ? 'Plano inicial definido. Atualize os dados da contratação.'
          : 'Preços salvos. Novas cobranças usarão estes valores.';
      } catch (e) {
        message.textContent = e instanceof Error ? e.message : 'Não foi possível salvar.';
      } finally {
        message.hidden = false;
        button.disabled = false;
      }
    })();
  });
}
