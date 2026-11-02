import './purchase-checkout.css';
type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Plan = { id: string; label: string; months: number; priceCents: number; enabled: boolean };
type Invoice = {
  id: string;
  label: string;
  months: number;
  total: number;
  status: string;
  expiresAt: string;
  qrCode: string;
  claimed?: boolean;
};
type Guest = { key: string; requestId: string; invoiceId?: string };
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const storageKey = 'blackout.checkout.purchase';
export async function mountPurchaseCheckout(
  host: HTMLElement,
  api: Api,
  email: string | null,
  helpUrl: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
) {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let partnerId = params.get('partner'),
    selected = 'monthly',
    plans: Plan[] = [],
    invoice: Invoice | null = null,
    guest: Guest | null = null,
    hasStore = false,
    busy = false;
  let name = '',
    storeName = '';
  try {
    if (partnerId) sessionStorage.setItem('blackout.checkout.partner', partnerId);
    else partnerId = sessionStorage.getItem('blackout.checkout.partner');
    const saved = sessionStorage.getItem('blackout.checkout.plan');
    if (['monthly', 'quarterly', 'annual'].includes(saved ?? '')) selected = saved!;
    const g = JSON.parse((storage ?? localStorage).getItem(storageKey) ?? 'null');
    if (g && /^[a-f0-9]{64}$/.test(g.key) && typeof g.requestId === 'string') guest = g;
  } catch {}
  const partnerQuery = partnerId ? '?partnerId=' + encodeURIComponent(partnerId) : '';
  const saveGuest = () => {
    try {
      (storage ?? localStorage).setItem(storageKey, JSON.stringify(guest));
    } catch {
      throw Error(
        'Permita o armazenamento neste navegador para guardar e recuperar sua compra antes de gerar o Pix.',
      );
    }
  };
  const isPending = () =>
    !!invoice &&
    ['creating', 'uncertain', 'awaiting_credit', 'awaiting_payment'].includes(invoice.status);
  const formFields = () =>
    `<label>Seu nome<input name="name" autocomplete="name" required minlength="2" maxlength="80" value="${esc(name)}"></label><label>Nome da loja<input name="storeName" required minlength="2" maxlength="80" value="${esc(storeName)}"></label>`;
  const authLink =
    '<a class="button-link" href="#/entrar?checkout=1&signup=1">Criar meu acesso</a>';
  const render = async () => {
    if (!host.isConnected) return;
    const plan = plans.find((p) => p.id === selected),
      pending = isPending(),
      paid = invoice?.status === 'paid',
      needsClaim = !!guest && paid && !invoice?.claimed,
      activeInvoice = pending || paid || invoice?.status === 'review_required' ? invoice : null,
      total = money(activeInvoice?.total ?? plan?.priceCents ?? 0);
    const buy = `<form data-purchase-form><p>Toque em Comprar agora para gerar o QR Code. Você cria o acesso e informa os dados da loja depois do pagamento.</p><button type="submit" data-purchase-buy ${!plan?.enabled ? 'disabled' : ''}>Comprar agora · ${total}</button><p class="pc-small">Pagamento único via Pix. Guarde esta aba ou volte pelo mesmo navegador para recuperar a compra.</p></form>`;
    const paidContent = needsClaim
      ? `<section class="pc-box pc-success"><h2>Pagamento confirmado. Agora prepare sua loja.</h2><p>Plano ${esc(invoice!.label)} · ${total}. Não é necessário pagar novamente.</p>${email ? `<p>Vincular à conta: <strong>${esc(email)}</strong></p><form data-purchase-claim>${formFields()}<button type="submit" data-purchase-claim-button>Concluir cadastro da loja</button></form>` : `<p>Crie seu acesso ou entre na sua conta para vincular esta compra. Depois, escolha o nome da sua loja.</p>${authLink}<p><a href="#/entrar?checkout=1">Já tenho acesso · entrar</a></p>`}<p class="pc-small">O período começa após a ativação do bot.</p></section>`
      : `<section class="pc-box pc-success"><h2>Próximo passo: configurar o bot</h2><p>Seu plano ${esc(invoice?.label)} está confirmado.</p><a class="button-link" href="#/configuracao">Configurar meu bot</a></section>`;
    const payContent = `<section class="pc-box" id="purchase-payment"><h2>${invoice?.qrCode ? 'Pague com Pix' : 'Cobrança em conferência'}</h2><p>${esc(invoice?.label)} · ${invoice?.months} mês(es) · <strong>${total}</strong></p>${invoice?.qrCode ? `<div class="pc-qr" data-purchase-qr></div><label>Pix copia e cola<textarea readonly rows="4" data-purchase-code>${esc(invoice.qrCode)}</textarea></label><div class="pc-buttons"><button data-purchase-copy>Copiar Pix</button><button class="quiet" data-purchase-check>Já paguei · verificar</button></div><p class="pc-small">Válido até ${new Date(invoice.expiresAt).toLocaleString('pt-BR')}. Confira o valor e o recebedor no banco. A confirmação é automática.</p>` : '<p>Estamos conferindo esta cobrança. Não crie outra cobrança nem pague duas vezes.</p><button class="quiet" data-purchase-check>Verificar esta cobrança</button>'}<p class="pc-small">Depois da confirmação você cria seu acesso e informa os dados da loja. Continue neste navegador.</p></section>`;
    const content = paid
      ? paidContent
      : invoice?.status === 'review_required'
        ? '<section class="pc-box"><h2>Precisamos conferir seu pagamento</h2><p>Não pague novamente. Fale com o atendimento e informe o número da cobrança.</p></section>'
        : pending
          ? payContent
          : hasStore
            ? '<section class="pc-box"><h2>Você já tem uma loja</h2><p>Renove a assinatura pelo seu painel.</p><a class="button-link" href="#/minha-loja?subscription=1">Abrir minha loja</a></section>'
            : `<section class="pc-box"><h2>Escolha o período</h2><fieldset class="pc-plans"><legend class="pc-sr">Planos Blackout</legend>${plans.map((p) => `<label class="pc-plan ${selected === p.id ? 'is-selected' : ''}"><input type="radio" name="purchase-plan" value="${p.id}" ${selected === p.id ? 'checked' : ''} ${!p.enabled ? 'disabled' : ''}><span><b>${esc(p.label)}</b><small>${p.months} ${p.months === 1 ? 'mês' : 'meses'} de acesso</small></span><strong>${money(p.priceCents)}</strong></label>`).join('')}</fieldset></section><section class="pc-box">${buy}</section>`;
    const action = paid
      ? needsClaim
        ? email
          ? '<button type="submit" form="purchase-claim-form" data-purchase-claim-button>Concluir cadastro</button>'
          : authLink
        : '<a class="button-link" href="#/configuracao">Configurar meu bot</a>'
      : invoice?.status === 'review_required'
        ? `<a class="button-link" href="${esc(helpUrl)}" target="_blank" rel="noopener noreferrer">Falar com atendimento</a>`
        : pending
          ? invoice!.qrCode
            ? '<button data-purchase-copy>Copiar Pix para pagar</button>'
            : '<button data-purchase-check>Verificar cobrança</button>'
          : hasStore
            ? '<a class="button-link" href="#/minha-loja?subscription=1">Renovar meu bot</a>'
            : `<button type="submit" form="purchase-order-form" data-purchase-buy ${!plan?.enabled ? 'disabled' : ''}>Comprar agora</button>`;
    const hint = paid
      ? 'Pagamento confirmado'
      : pending
        ? invoice!.qrCode
          ? 'Pix pronto · pague no app do banco'
          : 'Cobrança em conferência'
        : 'Pagamento único via Pix';
    host.innerHTML = `<div class="pc-layout"><section class="pc-content"><a class="pc-back" href="/">← Voltar ao site</a><h1>${paid ? 'Seu pagamento foi confirmado.' : 'Seu bot começa aqui.'}</h1><p class="pc-intro">${paid ? 'Agora crie seu acesso e prepare sua loja.' : 'Escolha o plano e pague com Pix. Sem login antes do pagamento.'}</p><ol class="pc-journey" aria-label="Etapas da contratação"><li ${!paid ? 'aria-current="step"' : ''}>1. Pagar</li><li ${paid ? 'aria-current="step"' : ''}>2. Criar acesso</li><li>3. Configurar loja</li></ol><p role="status" data-purchase-feedback hidden></p>${content}<section class="pc-help"><h2>Tem alguma dúvida?</h2><details><summary>O que acontece depois de pagar?</summary><p>O site confirma o Pix automaticamente. Em seguida, você cria ou acessa sua conta, confirma o e-mail e informa seu nome e o nome da loja. Depois, conecta o bot e segue a configuração guiada.</p></details><details><summary>A cobrança é recorrente?</summary><p>Não. Você paga uma vez pelo período escolhido e recebe avisos para renovar.</p></details><a class="pc-help-link" href="${esc(helpUrl)}" target="_blank" rel="noopener noreferrer">Falar com a Blackout no Telegram ↗</a></section></section><aside class="pc-summary" aria-label="Resumo da contratação"><a class="brand" href="/"><img src="/brand.webp" width="44" height="44" alt=""><span>Blackout <small>Create</small></span></a><h2>Sua loja no Telegram.</h2><dl><div><dt>Plano</dt><dd>${esc(activeInvoice?.label ?? plan?.label)}</dd></div><div><dt>Período</dt><dd>${activeInvoice?.months ?? plan?.months} mês(es)</dd></div><div><dt>Pagamento</dt><dd>Pix · PurinCash</dd></div><div class="pc-total"><dt>Total</dt><dd>${total}</dd></div></dl><div class="pc-desktop-action">${action}</div><p>${paid ? 'Pagamento registrado. Continue a configuração.' : 'O acesso e os dados da loja são preenchidos após o pagamento.'}</p>${invoice ? `<small>Cobrança ${esc(invoice.id)}</small>` : ''}</aside></div><nav class="pc-mobile-action" aria-label="Continuar contratação"><div class="pc-mobile-total"><small>${hint}</small><strong>${total}</strong></div><div class="pc-mobile-controls">${action}<a class="pc-mobile-help" href="${esc(helpUrl)}" target="_blank" rel="noopener noreferrer">Tem alguma dúvida?</a></div></nav>`;
    host.querySelector('[data-purchase-form]')?.setAttribute('id', 'purchase-order-form');
    host.querySelector('[data-purchase-claim]')?.setAttribute('id', 'purchase-claim-form');
    if (invoice?.qrCode && pending && invoice.status !== 'awaiting_credit') {
      const code = invoice.qrCode,
        src = await (await import('qrcode')).default.toDataURL(code, { width: 256, margin: 4 });
      if (invoice?.qrCode !== code) return;
      const el = host.querySelector('[data-purchase-qr]');
      if (el) {
        const image = document.createElement('img');
        image.src = src;
        image.alt = 'QR Code Pix da sua contratação Blackout';
        el.replaceChildren(image);
      }
    }
  };
  const feedback = (text: string) => {
    const e = host.querySelector<HTMLElement>('[data-purchase-feedback]');
    if (e) {
      e.hidden = false;
      e.textContent = text;
      e.scrollIntoView({ block: 'center' });
    }
  };
  const action = async (fn: () => Promise<void>, quiet = false) => {
    if (busy) return;
    busy = true;
    const states = new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button'), (b) => [b, b.disabled]),
    );
    states.forEach((_, b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      if (!quiet)
        feedback(
          e instanceof Error
            ? e.message
            : 'Não foi possível concluir. Verifique a cobrança antes de tentar novamente.',
        );
    } finally {
      busy = false;
      states.forEach((was, b) => {
        if (b.isConnected) b.disabled = was;
      });
    }
  };
  const remember = (next: Invoice) => {
    invoice = next;
    if (guest) {
      guest.invoiceId = next.id;
      saveGuest();
    }
  };
  const refresh = async () => {
    plans = (await api<{ plans: Plan[] }>('/checkout/plans' + partnerQuery)).plans;
    if (guest) {
      try {
        remember(
          await api<Invoice>('/checkout/guest/read', {
            key: guest.key,
            ...(guest.invoiceId ? { invoiceId: guest.invoiceId } : {}),
          }),
        );
      } catch (e) {
        if (guest.invoiceId) throw e;
      }
      return;
    }
    if (email) {
      const data = await api<{ hasStore: boolean; invoice: Invoice | null }>(
        '/checkout/purchase' + partnerQuery,
      );
      hasStore = data.hasStore;
      invoice = data.invoice;
    }
  };
  const check = async () => {
    if (!invoice) return;
    const next = await api<Invoice>(
      guest ? '/checkout/guest/check' : '/checkout/purchase/check',
      guest ? { invoiceId: invoice.id, key: guest.key } : { invoiceId: invoice.id },
    );
    if (JSON.stringify(next) !== JSON.stringify(invoice)) {
      remember(next);
      await render();
    }
  };
  host.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.name === 'purchase-plan' && !busy) {
      selected = el.value;
      try {
        sessionStorage.setItem('blackout.checkout.plan', selected);
      } catch {}
      void render();
    }
  });
  host.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.name === 'name') name = el.value;
    if (el.name === 'storeName') storeName = el.value;
  });
  host.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (!form.matches('[data-purchase-form],[data-purchase-claim]')) return;
    e.preventDefault();
    void action(async () => {
      if (form.matches('[data-purchase-claim]')) {
        if (!guest || !invoice) return;
        const fields = new FormData(form);
        await api('/checkout/guest/claim', {
          invoiceId: invoice.id,
          key: guest.key,
          name: String(fields.get('name')),
          storeName: String(fields.get('storeName')),
        });
        invoice = { ...invoice, claimed: true };
        await render();
        location.hash = '/configuracao';
        return;
      }
      const p = plans.find((p) => p.id === selected);
      if (!p?.enabled) return;
      if (!guest) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        guest = {
          key: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
          requestId: crypto.randomUUID(),
        };
      } else if (invoice && ['failed', 'expired'].includes(invoice.status))
        guest.requestId = crypto.randomUUID();
      saveGuest();
      host
        .querySelectorAll('[data-purchase-buy]')
        .forEach((b) => (b.textContent = 'Gerando seu Pix…'));
      try {
        remember(
          await api<Invoice>('/checkout/guest/create', {
            key: guest.key,
            requestId: guest.requestId,
            plan: p.id,
            expectedPriceCents: p.priceCents,
            ...(partnerId ? { partnerId } : {}),
          }),
        );
        await render();
        host.querySelector('#purchase-payment')?.scrollIntoView({ block: 'start' });
      } catch (e) {
        await refresh().catch(() => {});
        await render();
        throw e;
      }
    });
  });
  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.hasAttribute('data-purchase-check'))
      void action(async () => {
        await check();
        await render();
        host.querySelector('#purchase-payment')?.scrollIntoView({ block: 'start' });
        if (invoice && !invoice.qrCode && isPending())
          feedback(
            'A cobrança ainda está em conferência. Não pague novamente. Use o atendimento se continuar assim.',
          );
      });
    if (b?.hasAttribute('data-purchase-copy') && invoice?.qrCode)
      void action(async () => {
        await navigator.clipboard.writeText(invoice!.qrCode);
        feedback('Pix copiado. Abra o aplicativo do seu banco para pagar.');
      });
  });
  try {
    await refresh();
    await render();
  } catch (e) {
    host.innerHTML = `<section class="pc-box"><h1>Checkout temporariamente indisponível</h1><p>${esc(e instanceof Error ? e.message : 'Tente novamente.')}</p><a href="${esc(helpUrl)}" target="_blank" rel="noopener noreferrer">Falar com a Blackout</a></section>`;
    return;
  }
  const timer = window.setInterval(() => {
    if (!host.isConnected) {
      clearInterval(timer);
      return;
    }
    if (!busy && invoice && isPending() && document.visibilityState === 'visible')
      void action(check, true);
  }, 15000);
}
