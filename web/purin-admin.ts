type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export async function mountPurinAdmin(host: HTMLElement, api: Api, merchantId?: string) {
  const base = merchantId ? '/admin/accounts/' + merchantId + '/purin' : '/admin/payments/purin';
  const render = async () => {
    const status = await api<{ connected: boolean; subaccountId?: string; requested?: boolean }>(
      base,
    );
    if (!host.isConnected) return;
    host.innerHTML = merchantId
      ? `<h3>Pix automático Blackout</h3><p>${status.connected ? 'Subconta vinculada: ' + esc(status.subaccountId) : status.requested ? 'Este lojista solicitou a ativação.' : 'Sem subconta vinculada.'}</p><p>Crie a subconta na PurinCash e use este identificador externo:</p><input aria-label="Identificador externo do lojista" readonly value="${esc(merchantId)}"><form><label>ID da subconta<input name="subaccountId" required pattern="sacc_[A-Za-z0-9_-]+" maxlength="125" placeholder="sacc_…" value="${esc(status.subaccountId)}"></label><button type="submit">Verificar e vincular subconta</button></form>`
      : `<h2>Pix automático Blackout · PurinCash</h2><p>${status.connected ? 'Conta principal conectada. Preencha somente para atualizar a conexão.' : 'Conecte a conta principal para ativar os lojistas.'}</p><p>Comissão Blackout: R$ 0,00 por venda nesta integração. As tarifas da PurinCash continuam valendo. O dinheiro permanece na carteira principal, atribuído às subcontas. Os repasses são gerenciados por você na PurinCash.</p><details ${status.connected ? '' : 'open'}><summary>${status.connected ? 'Atualizar credenciais' : 'Configurar conexão'}</summary><p>Na PurinCash, crie uma chave de produção com Criar cobranças, Consultar cobranças e Gerenciar subcontas. Cole também o Webhook Secret da conta. Não habilite saques.</p><form><label>API Key de produção<input name="accessToken" type="password" autocomplete="off" required pattern="ps_live_[A-Za-z0-9_-]+" maxlength="520" placeholder="ps_live_…"></label><label>Webhook Secret da conta<input name="webhookSecret" type="password" autocomplete="off" required minlength="16" maxlength="512"></label><button type="submit">Validar e conectar PurinCash</button></form></details>`;
    host.insertAdjacentHTML(
      'beforeend',
      '<p class="feedback" role="status" data-purin-feedback hidden></p>',
    );
  };
  host.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target as HTMLFormElement,
      button = form.querySelector('button')!;
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      await api(merchantId ? base : base + '/connect', data);
      form.reset();
      await render();
      const feedback = host.querySelector<HTMLElement>('[data-purin-feedback]');
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = merchantId
          ? 'Subconta verificada e vinculada. O lojista já pode escolher Pix automático Blackout em Pagamentos.'
          : 'Conta PurinCash conectada. Selecione um lojista para vincular sua subconta.';
      }
    } catch (error) {
      const feedback = host.querySelector<HTMLElement>('[data-purin-feedback]');
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent =
          error instanceof Error ? error.message : 'Não foi possível conectar.';
      }
    } finally {
      button.disabled = false;
    }
  });
  try {
    await render();
  } catch (error) {
    if (host.isConnected)
      host.textContent = error instanceof Error ? error.message : 'Conexão indisponível.';
  }
}
