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
};
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (v: number) =>
  (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export async function mountPurchaseCheckout(
  host: HTMLElement,
  api: Api,
  email: string | null,
  helpUrl: string,
) {
  let plans: Plan[] = [],
    selected = 'monthly',
    invoice: Invoice | null = null,
    hasStore = false,
    busy = false;
  let name = '',
    storeName = '',
    confirmed = false;
  try {
    const saved = sessionStorage.getItem('blackout.checkout.plan');
    if (['monthly', 'quarterly', 'annual'].includes(saved ?? '')) selected = saved!;
  } catch {}
  const render = async () => {
    if (!host.isConnected) return;
    const p = plans.find((p) => p.id === selected),
      pending = invoice && ['creating', 'uncertain', 'awaiting_payment'].includes(invoice.status),
      paid = invoice?.status === 'paid';
    host.innerHTML = `<div class="pc-layout"><section class="pc-content"><a class="pc-back" href="/">← Voltar ao site</a><h1>${paid ? 'Seu pagamento foi confirmado.' : 'Seu bot começa aqui.'}</h1><p class="pc-intro">${paid ? 'Agora é hora de preparar sua loja e conectar o seu bot.' : 'Escolha seu plano Blackout e pague com Pix. A gestão da loja fica no seu painel; as vendas, no Telegram.'}</p>${hasStore && !invoice ? '<section class="pc-box"><h2>Você já tem uma loja</h2><p>Acesse sua assinatura para renovar o plano ou continue a configuração do seu bot.</p><a class="button-link" href="#/minha-loja?subscription=1">Abrir minha loja</a></section>' : paid ? `<section class="pc-box pc-success"><h2>Próximo passo: configurar o bot</h2><p>Seu plano ${esc(invoice!.label)} foi contratado. O período de ${invoice!.months} mês(es) começa após a ativação do bot.</p><a class="button-link" href="#/configuracao">Configurar meu bot</a></section>` : invoice?.status === 'review_required' ? '<section class="pc-box"><h2>Precisamos conferir seu pagamento</h2><p>Não pague novamente. Use o atendimento abaixo e informe o número da cobrança.</p></section>' : pending ? `<section class="pc-box"><h2>${invoice!.qrCode ? 'Pague com Pix' : 'Cobrança em conferência'}</h2><p>${esc(invoice!.label)} · ${invoice!.months} mês(es) · <strong>${money(invoice!.total)}</strong></p>${invoice!.qrCode ? `<div class="pc-qr" data-purchase-qr></div><label>Pix copia e cola<textarea readonly rows="4" data-purchase-code>${esc(invoice!.qrCode)}</textarea></label><div class="pc-buttons"><button data-purchase-copy>Copiar Pix</button><button class="quiet" data-purchase-check>Já paguei · verificar</button></div><p class="pc-small">Válido até ${new Date(invoice!.expiresAt).toLocaleString('pt-BR')}. Confira o valor e o recebedor no banco antes de pagar. A confirmação é automática.</p>` : '<p>Estamos conferindo a geração deste Pix. Não crie outra cobrança nem pague duas vezes.</p><button class="quiet" data-purchase-check>Verificar esta cobrança</button>'}</section>` : `<section class="pc-box"><h2>Escolha o período</h2><fieldset class="pc-plans"><legend class="pc-sr">Planos Blackout</legend>${plans.map((plan) => `<label class="pc-plan ${selected === plan.id ? 'is-selected' : ''}"><input type="radio" name="purchase-plan" value="${plan.id}" ${selected === plan.id ? 'checked' : ''} ${!plan.enabled ? 'disabled' : ''}><span><b>${esc(plan.label)}</b><small>${plan.months} ${plan.months === 1 ? 'mês' : 'meses'} de acesso</small></span><strong>${money(plan.priceCents)}</strong></label>`).join('')}</fieldset></section>${!email ? '<section class="pc-box"><h2>Seu acesso, protegido</h2><p>Entre ou crie uma conta e confirme seu e-mail para vincular o pagamento à sua loja. Nenhuma cobrança é gerada nesta etapa.</p><a class="button-link" href="#/entrar?checkout=1">Comprar agora · continuar com meu e-mail</a></section>' : `<section class="pc-box"><h2>Dados da sua loja</h2><p>Conta: <strong>${esc(email)}</strong></p><form id="purchase-order-form" data-purchase-form><label>Seu nome<input name="name" autocomplete="name" required minlength="2" maxlength="80" value="${esc(name)}"></label><label>Nome da loja<input name="storeName" required minlength="2" maxlength="80" value="${esc(storeName)}"></label><label class="pc-confirm"><input type="checkbox" name="confirmed" required ${confirmed ? 'checked' : ''}><span>Conferi o plano e o valor. Entendo que a ativação do bot ocorre após a configuração com a Blackout.</span></label><button type="submit" data-purchase-buy ${!p?.enabled ? 'disabled' : ''}>Comprar agora · ${money(p?.priceCents ?? 0)}</button><p class="pc-small">Ao comprar, geramos o QR Code Pix. O pagamento é feito pelo aplicativo do seu banco.</p></form></section>`}`}
 <section class="pc-help"><h2>Tem alguma dúvida?</h2><details><summary>O que está incluído?</summary><p>Bot de vendas de produtos digitais no Telegram e painel web para catálogo, estoque, pedidos, personalização e carteira. O Pix integrado para as vendas da sua loja depende de habilitação e tem taxas próprias.</p></details><details><summary>Quando começa meu período?</summary><p>Depois da configuração e confirmação da ativação do bot. O pagamento libera seu painel e registra o plano contratado; não inicia a hospedagem sozinho.</p></details><details><summary>A cobrança é recorrente?</summary><p>Não. Este Pix paga uma vez pelo período escolhido. Você recebe avisos antes do vencimento e escolhe quando renovar.</p></details><a class="pc-help-link" href="${esc(helpUrl)}" target="_blank" rel="noopener noreferrer">Falar com a Blackout no Telegram ↗</a></section><p role="status" data-purchase-feedback hidden></p></section><aside class="pc-summary" aria-label="Resumo da contratação"><a class="brand" href="/"><img src="/brand.webp" width="44" height="44" alt=""><span>Blackout <small>Create</small></span></a><h2>Loja no Telegram.<br>Controle no site.</h2><dl><div><dt>Plano</dt><dd>${esc(invoice?.label ?? p?.label ?? 'Escolha um plano')}</dd></div><div><dt>Período</dt><dd>${invoice?.months ?? p?.months ?? 1} mês(es)</dd></div><div><dt>Pagamento</dt><dd>Pix · PurinCash</dd></div><div class="pc-total"><dt>Total</dt><dd>${money(invoice?.total ?? p?.priceCents ?? 0)}</dd></div></dl>${!pending && !paid && invoice?.status !== 'review_required' ? hasStore && !invoice ? '<a class="button-link pc-buy" href="#/minha-loja?subscription=1">Renovar meu bot</a>' : email ? `<button class="pc-buy" type="submit" form="purchase-order-form" data-purchase-buy ${!p?.enabled ? 'disabled' : ''}>Comprar agora · ${money(p?.priceCents ?? 0)}</button><small>Preencha os dados da loja e confirme o plano para gerar o Pix.</small>` : `<a class="button-link pc-buy" href="#/entrar?checkout=1">Comprar agora · ${money(p?.priceCents ?? 0)}</a><small>Entre ou crie sua conta para continuar a compra.</small>` : ''}<p>Pagamento único para este período. A carteira das vendas da sua loja é separada desta contratação.</p>${invoice ? `<small>Cobrança ${esc(invoice.id)}</small>` : ''}</aside></div>`;
    if (invoice?.qrCode && pending) {
      const QR = (await import('qrcode')).default,
        src = await QR.toDataURL(invoice.qrCode, { width: 256, margin: 4 });
      const el = host.querySelector('[data-purchase-qr]');
      if (el) {
        const image = document.createElement('img');
        image.src = src;
        image.alt = 'QR Code Pix da sua contratação Blackout';
        el.append(image);
      }
    }
  };
  const feedback = (text: string) => {
    const e = host.querySelector<HTMLElement>('[data-purchase-feedback]');
    if (e) {
      e.hidden = false;
      e.textContent = text;
    }
  };
  const action = async (fn: () => Promise<void>, quiet = false) => {
    if (busy) return;
    busy = true;
    const states = new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button'), (b) => [b, b.disabled]),
    );
    states.forEach((_v, b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      if (!quiet)
        feedback(
          e instanceof Error
            ? e.message
            : 'Não foi possível concluir. Use Verificar pagamento antes de tentar novamente.',
        );
    } finally {
      busy = false;
      states.forEach((was, b) => {
        if (b.isConnected) b.disabled = was;
      });
    }
  };
  const refresh = async () => {
    const data = await api<{ plans: Plan[]; hasStore: boolean; invoice: Invoice | null }>(
      '/checkout/purchase',
    );
    plans = data.plans;
    hasStore = data.hasStore;
    invoice = data.invoice;
  };
  const check = async () => {
    if (!invoice) return;
    const next = await api<Invoice>('/checkout/purchase/check', { invoiceId: invoice.id });
    if (JSON.stringify(next) !== JSON.stringify(invoice)) {
      invoice = next;
      await render();
    }
  };
  host.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'purchase-plan' && !busy) {
      selected = input.value;
      try {
        sessionStorage.setItem('blackout.checkout.plan', selected);
      } catch {}
      void render();
    }
  });
  host.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'name') name = input.value;
    if (input.name === 'storeName') storeName = input.value;
    if (input.name === 'confirmed') confirmed = input.checked;
  });
  host.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-purchase-form]')) return;
    event.preventDefault();
    const fields = new FormData(form),
      p = plans.find((p) => p.id === selected);
    if (!p || !fields.get('confirmed')) return;
    void action(async () => {
      host.querySelectorAll<HTMLButtonElement>('[data-purchase-buy]').forEach((button) => {
        button.textContent = 'Gerando seu Pix…';
      });
      try {
        invoice = await api<Invoice>('/checkout/purchase/create', {
          name: String(fields.get('name')),
          storeName: String(fields.get('storeName')),
          plan: p.id,
          expectedPriceCents: p.priceCents,
          requestId: crypto.randomUUID(),
        });
        await render();
      } catch (e) {
        await refresh().catch(() => {});
        await render();
        throw e;
      }
    });
  });
  host.addEventListener('click', (event) => {
    const b = (event.target as HTMLElement).closest('button');
    if (b?.hasAttribute('data-purchase-check')) void action(check);
    if (b?.hasAttribute('data-purchase-copy') && invoice?.qrCode)
      void action(async () => {
        await navigator.clipboard.writeText(invoice!.qrCode);
        feedback('Pix copiado.');
      });
  });
  try {
    if (email) await refresh();
    else plans = (await api<{ plans: Plan[] }>('/checkout/plans')).plans;
    await render();
  } catch (e) {
    host.innerHTML = `<section class="pc-box"><h1>Checkout temporariamente indisponível</h1><p>${esc(e instanceof Error ? e.message : 'Tente novamente em instantes.')}</p><a href="${esc(helpUrl)}" target="_blank" rel="noopener noreferrer">Tem alguma dúvida? Fale com a Blackout ↗</a></section>`;
    return;
  }
  const timer = window.setInterval(() => {
    if (!host.isConnected) {
      clearInterval(timer);
      return;
    }
    if (
      email &&
      !busy &&
      invoice &&
      ['creating', 'uncertain', 'awaiting_payment'].includes(invoice.status) &&
      document.visibilityState === 'visible'
    )
      void action(check, true);
  }, 15000);
}
