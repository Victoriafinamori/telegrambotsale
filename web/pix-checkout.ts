type Checkout = {
  title: string;
  orderId: string;
  total: number;
  items: { title: string; quantity: number }[];
  status: string;
  open: boolean;
  expiresAt: string;
  qrCode: string;
  qrBase64: string;
};
type Request = (path: string, body: unknown) => Promise<Checkout>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export async function mountPixCheckout(host: HTMLElement, hash: string, request: Request) {
  const match = /^#\/pagar\/([a-f0-9-]{36})\/([a-f0-9]{16})\/([A-Za-z0-9_-]{43})$/.exec(hash);
  const root = document.createElement('main');
  root.className = 'pix-checkout';
  host.replaceChildren(root);
  document.title = 'Pagamento Pix · Blackout Create';
  if (!match) {
    root.innerHTML =
      '<section class="mc-panel"><h1>Link de pagamento inválido</h1><p>Abra o pedido pelo seu bot no Telegram.</p></section>';
    return;
  }
  const base = { accountId: match[1], orderId: match[2], key: match[3] };
  let data: Checkout,
    busy = false;
  const feedback = (text: string) => {
    const el = root.querySelector<HTMLElement>('[data-pix-feedback]');
    if (el) {
      el.hidden = false;
      el.textContent = text;
    }
  };
  const render = () => {
    if (!root.isConnected) return;
    const paid = ['paid', 'delivered'].includes(data.status);
    root.innerHTML = `<a class="brand" href="#/">Blackout Create</a><section class="mc-panel"><h1>${esc(data.title)}</h1><p>Pedido ${esc(data.orderId)}</p><ul>${data.items.map((item) => `<li>${item.quantity} × ${esc(item.title)}</li>`).join('')}</ul><p class="pix-total">${(data.total / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p><p role="status">${paid ? 'Pagamento confirmado. Acompanhe a entrega no seu Telegram.' : data.status === 'refund_required' ? 'Pagamento recebido para um pedido encerrado. Fale com o suporte da loja para atendimento/reembolso.' : !data.open ? 'Este pedido está encerrado ou venceu. Retorne ao Telegram para consultar seu histórico.' : 'Pague com Pix pelo Mercado Pago.'}</p>${data.open ? (data.qrCode ? `<div class="pix-qr">${data.qrBase64 && /^[A-Za-z0-9+/=]+$/.test(data.qrBase64) ? `<img src="data:image/png;base64,${data.qrBase64}" alt="QR Code Pix deste pedido">` : ''}</div><label>Pix copia e cola<textarea readonly rows="4" data-pix-code>${esc(data.qrCode)}</textarea></label><div class="mc-shortcuts"><button data-copy-pix>Copiar Pix</button><button class="quiet" data-check-pix>Verificar confirmação</button></div><p>Válido até ${new Date(data.expiresAt).toLocaleString('pt-BR')}. Confira o valor e o recebedor no aplicativo do banco antes de pagar.</p><p>A confirmação é automática. A entrega será enviada ao Telegram vinculado ao pedido.</p>` : `<form data-create-pix><p>Informe os dados do pagador para gerar o Pix. Estes dados serão enviados ao Mercado Pago para processar este pagamento.</p><label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>Tipo de documento<select name="documentType"><option value="CPF">CPF</option><option value="CNPJ">CNPJ</option></select></label><label>CPF ou CNPJ do pagador<input name="document" inputmode="numeric" autocomplete="off" required minlength="11" maxlength="20"></label><button type="submit">Gerar Pix deste pedido</button></form>`) : ''}<p data-pix-feedback class="feedback" role="status" hidden></p></section>`;
  };
  const work = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    buttons.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (error) {
      feedback(
        error instanceof Error ? error.message : 'Não foi possível consultar. Tente novamente.',
      );
    } finally {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  root.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const fields = new FormData(event.target as HTMLFormElement);
    void work(async () => {
      data = await request('create', {
        ...base,
        payer: {
          email: String(fields.get('email') ?? '').trim(),
          documentType: String(fields.get('documentType')),
          document: String(fields.get('document') ?? ''),
        },
      });
      render();
      if (data.open && !data.qrCode)
        feedback(
          'A cobrança foi criada, mas o QR ainda não ficou disponível. Tente novamente para consultar a mesma cobrança.',
        );
    });
  });
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    event.stopPropagation();
    if (button.hasAttribute('data-copy-pix'))
      void work(async () => {
        try {
          await navigator.clipboard.writeText(data.qrCode);
          feedback('Pix copiado. Cole no aplicativo do seu banco.');
        } catch {
          root.querySelector<HTMLTextAreaElement>('[data-pix-code]')?.select();
          feedback('Selecione o código e copie para o aplicativo do banco.');
        }
      });
    if (button.hasAttribute('data-check-pix'))
      void work(async () => {
        data = await request('refresh', base);
        render();
        if (data.open) feedback('O Mercado Pago ainda não confirmou o pagamento.');
      });
  });
  root.innerHTML = '<p role="status">Carregando pagamento…</p>';
  try {
    data = await request('details', base);
    render();
  } catch (error) {
    if (root.isConnected)
      root.innerHTML = `<section class="mc-panel"><h1>Não foi possível abrir o pagamento</h1><p>${esc(error instanceof Error ? error.message : 'Abra o pedido pelo Telegram novamente.')}</p></section>`;
    return;
  }
  const timer = window.setInterval(() => {
    if (!root.isConnected || !data.open) {
      clearInterval(timer);
      return;
    }
    if (busy || document.hidden || !data.qrCode) return;
    void request('details', base)
      .then((fresh) => {
        if (!root.isConnected) return;
        const changed = fresh.status !== data.status || fresh.open !== data.open;
        data = fresh;
        if (changed) render();
      })
      .catch(() =>
        feedback(
          'Conexão temporariamente indisponível. Use Verificar confirmação para consultar novamente.',
        ),
      );
  }, 10000);
  window.addEventListener('hashchange', () => clearInterval(timer), { once: true });
}
