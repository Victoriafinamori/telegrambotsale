type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
type Key = { type: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random'; value: string; holder: string };
type Settings = {
  mode: 'manual' | 'mercadopago' | 'purincash' | 'stars';
  purinConnected: boolean;
  purinRequested: boolean;
  keys: Key[];
  instructions: string;
  revision: number;
  connected: boolean;
  merchantName: string;
  merchantId: string;
  webhookUrl: string;
};
const types = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  phone: 'Celular com +55 e DDD',
  random: 'Chave aleatória',
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export async function mountPaymentSettings(
  host: HTMLElement,
  api: Api,
  onSaved: () => Promise<void>,
) {
  let state: Settings,
    busy = false;
  const message = (text: string, error = false) => {
    const el = host.querySelector<HTMLElement>('[data-payment-feedback]');
    if (el) {
      el.hidden = false;
      el.textContent = text;
      el.classList.toggle('is-error', error);
    }
  };
  const rows = () =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-pix-key]')).map((row) => ({
      type: row.querySelector<HTMLSelectElement>('select')!.value as Key['type'],
      value: row.querySelector<HTMLInputElement>('[data-key-value]')!.value.trim(),
      holder: row.querySelector<HTMLInputElement>('[data-key-holder]')!.value.trim(),
    }));
  const updatePreview = () => {
    const target = host.querySelector<HTMLElement>('[data-manual-preview]');
    if (!target) return;
    const lines = rows()
      .filter((key) => key.value)
      .map(
        (key) =>
          `${types[key.type]}: ${key.value}${key.holder ? '\nRecebedor: ' + key.holder : ''}`,
      );
    const notes = host.querySelector<HTMLTextAreaElement>('[name="instructions"]')?.value.trim();
    if (notes) lines.push(notes);
    target.textContent =
      lines.join('\n\n') || 'Suas chaves e instruções aparecerão aqui enquanto você edita.';
  };
  const renderRows = (keys: Key[]) => {
    host.querySelector('[data-keys]')!.innerHTML =
      keys
        .map(
          (key, i) =>
            `<fieldset class="mc-pix-key" data-pix-key><legend>Chave Pix ${i + 1}</legend><label>Tipo de chave<select>${Object.entries(
              types,
            )
              .map(
                ([id, name]) =>
                  `<option value="${id}" ${id === key.type ? 'selected' : ''}>${name}</option>`,
              )
              .join(
                '',
              )}</select></label><label>Chave<input data-key-value maxlength="254" value="${esc(key.value)}" placeholder="Digite a chave do tipo escolhido"></label><label>Nome do recebedor<input data-key-holder maxlength="80" value="${esc(key.holder)}"></label><button type="button" class="text-button" data-remove-key="${i}">Remover esta chave</button></fieldset>`,
        )
        .join('') ||
      '<p>Nenhuma chave cadastrada. Adicione uma chave ou use as instruções de transferência abaixo.</p>';
    host.querySelector<HTMLButtonElement>('[data-add-key]')!.disabled = keys.length >= 3;
    updatePreview();
  };
  const mode = () => host.querySelector<HTMLSelectElement>('[name="paymentMode"]')!.value;
  const toggleMode = () => {
    host.querySelector<HTMLElement>('[data-manual-fields]')!.hidden = mode() !== 'manual';
    host.querySelector<HTMLElement>('[data-automatic-help]')!.hidden = mode() !== 'mercadopago';
    host.querySelector<HTMLElement>('[data-purin-help]')!.hidden = mode() !== 'purincash';
    host.querySelector<HTMLButtonElement>('[data-save-payment]')!.disabled =
      busy ||
      (mode() === 'mercadopago' && !state.connected) ||
      (mode() === 'purincash' && !state.purinConnected);
  };
  const render = () => {
    if (!host.isConnected) return;
    host.innerHTML = `<p class="feedback" data-payment-feedback role="status" hidden></p><section class="mc-panel"><h2>Como a loja recebe pagamentos</h2><form data-payment-options><label>Forma de pagamento<select name="paymentMode"><option value="manual" ${state.mode === 'manual' ? 'selected' : ''}>Pix/transferência manual</option><option value="purincash" ${state.mode === 'purincash' ? 'selected' : ''}>Pix automático · Blackout</option><option value="mercadopago" ${state.mode === 'mercadopago' ? 'selected' : ''}>Pix automático · Mercado Pago</option>${state.mode === 'stars' ? '<option value="stars" selected>Telegram Stars</option>' : ''}</select></label><div data-manual-fields><h3>Suas chaves Pix</h3><p>Escolha o tipo de cada chave. Até três chaves podem aparecer nas instruções do comprador.</p><div data-keys></div><button class="quiet" type="button" data-add-key>Adicionar chave Pix</button><label>Instruções adicionais ou dados de transferência<textarea name="instructions" maxlength="1000" rows="4">${esc(state.instructions)}</textarea></label><div class="mc-pix-instructions-preview"><h3>Prévia para o comprador</h3><p data-manual-preview></p></div><p class="mc-note">No manual, o cliente envia o comprovante pelo Telegram e você confere o recebimento antes de aprovar. O QR opcional de uma unidade é configurado em Produtos.</p></div><p data-automatic-help>O Mercado Pago gera um Pix para o total do pedido, incluindo quantidades e descontos. A entrega é liberada após a confirmação automática. ${state.connected ? 'Conta conectada: ' + esc(state.merchantName) + '.' : 'Conecte a conta abaixo para habilitar esta opção.'}</p><div data-purin-help><p>Um Pix para o total do carrinho, com confirmação e entrega automáticas pelo sistema Blackout. ${state.purinConnected ? 'Sua subconta está vinculada. Salve para ativar.' : 'A equipe Blackout precisa vincular sua subconta antes da ativação.'}</p>${!state.purinConnected ? `<button type="button" class="quiet" data-request-purin ${state.purinRequested ? 'disabled' : ''}>${state.purinRequested ? 'Ativação solicitada' : 'Solicitar ativação do Pix Blackout'}</button>` : ''}</div><button data-save-payment type="submit">Salvar forma de pagamento</button></form></section><section class="mc-panel"><h2>Conectar Mercado Pago</h2><p>${state.connected ? `Conta conectada: <strong>${esc(state.merchantName)}</strong> · ID ${esc(state.merchantId)}. Para trocar as credenciais, preencha os campos abaixo.` : 'Use a conta Mercado Pago do próprio lojista, habilitada para receber Pix.'}</p><ol><li>Abra Suas integrações no Mercado Pago Developers e selecione a aplicação da loja.</li><li>Em Webhooks, configure esta URL em produção e selecione o evento Pagamentos.</li><li>Copie o Access Token de produção e a assinatura secreta do webhook para os campos abaixo.</li></ol><label>URL de notificações desta loja<input readonly value="${esc(state.webhookUrl)}" aria-label="URL de notificações desta loja"></label><p>As credenciais ficam cifradas no servidor e não são enviadas ao bot ou exibidas novamente.</p><form data-payment-connect><label>Access Token de produção<input name="accessToken" type="password" autocomplete="off" required minlength="20" maxlength="1024" placeholder="Cole o Access Token da sua conta"></label><label>Assinatura secreta do webhook<input name="webhookSecret" type="password" autocomplete="off" required minlength="16" maxlength="512" placeholder="Cole a chave secreta das notificações"></label><button type="submit">${state.connected ? 'Atualizar conexão' : 'Conectar minha conta'}</button></form></section>`;
    renderRows(state.keys);
    toggleMode();
  };
  const work = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'));
    buttons.forEach((button) => (button.disabled = true));
    try {
      await fn();
    } catch (error) {
      message(
        error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.',
        true,
      );
    } finally {
      busy = false;
      if (host.isConnected) {
        buttons.forEach((button) => (button.disabled = false));
        const add = host.querySelector<HTMLButtonElement>('[data-add-key]');
        if (add) add.disabled = rows().length >= 3;
        toggleMode();
        const request = host.querySelector<HTMLButtonElement>('[data-request-purin]');
        if (request) request.disabled = state.purinRequested;
      }
    }
  };
  host.addEventListener('change', (event) => {
    event.stopPropagation();
    if ((event.target as HTMLElement).matches('[name="paymentMode"]')) toggleMode();
    updatePreview();
  });
  host.addEventListener('input', () => updatePreview());
  host.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    event.stopPropagation();
    if (button.hasAttribute('data-request-purin') && !busy)
      void work(async () => {
        await api('/store/manage/payments/purin/request', {});
        state.purinRequested = true;
        render();
        message('Solicitação enviada. A Blackout vai vincular sua subconta.');
      });
    if (button.hasAttribute('data-add-key') && !busy) {
      const keys = rows();
      if (keys.length < 3) {
        keys.push({ type: 'email', value: '', holder: '' });
        renderRows(keys);
      }
    }
    if (button.dataset.removeKey !== undefined && !busy) {
      const keys = rows();
      keys.splice(Number(button.dataset.removeKey), 1);
      renderRows(keys);
    }
  });
  host.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target as HTMLFormElement;
    void work(async () => {
      if (form.hasAttribute('data-payment-connect')) {
        const data = new FormData(form);
        state = await api<Settings>('/store/manage/payments/connect', {
          accessToken: String(data.get('accessToken') ?? '').trim(),
          webhookSecret: String(data.get('webhookSecret') ?? '').trim(),
          revision: state.revision,
        });
        form.reset();
        await onSaved();
        render();
        message('Conta conectada. Escolha Pix automático e salve a forma de pagamento.');
      } else {
        const keys = rows().filter((key) => key.value || key.holder);
        if (keys.some((key) => !key.value))
          throw Error('Preencha o valor de cada chave ou remova a linha vazia.');
        await api('/store/manage/payments', {
          mode: mode(),
          keys,
          instructions: String(new FormData(form).get('instructions') ?? ''),
          revision: state.revision,
        });
        await onSaved();
        state = await api<Settings>('/store/manage/payments');
        render();
        message('Forma de pagamento salva. Novos pedidos já usam esta configuração.');
      }
    });
  });
  try {
    state = await api<Settings>('/store/manage/payments');
    render();
  } catch (error) {
    if (host.isConnected) {
      host.innerHTML = '<p class="feedback" data-payment-feedback role="alert"></p>';
      message(
        error instanceof Error ? error.message : 'Não foi possível carregar os pagamentos.',
        true,
      );
    }
  }
}
