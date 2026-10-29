type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export async function mountPurinAdmin(host: HTMLElement, api: Api, merchantId?: string) {
  const base = merchantId ? '/admin/accounts/' + merchantId + '/purin' : '/admin/payments/purin';
  const render = async () => {
    const status = await api<{
      connected: boolean;
      subaccountId?: string;
      requested?: boolean;
      saleFeePercent?: number;
      withdrawalsEnabled?: boolean;
    }>(base);
    if (!host.isConnected) return;
    host.innerHTML = merchantId
      ? `<h3>Pix automático Blackout</h3><p>${status.connected ? 'Subconta vinculada: ' + esc(status.subaccountId) : status.requested ? 'Este lojista solicitou a ativação.' : 'Sem subconta vinculada.'}</p><p>Crie a subconta na PurinCash e use este identificador externo:</p><input aria-label="Identificador externo do lojista" readonly value="${esc(merchantId)}"><form data-sale-policy><label>Comissão Blackout nas vendas<select name="saleFeePercent"><option value="12" ${status.saleFeePercent === 0 ? '' : 'selected'}>Padrão · 12%</option><option value="0" ${status.saleFeePercent === 0 ? 'selected' : ''}>Isenta · 0%</option></select></label><p>A isenção vale para esta loja. Saques: R$ 1 Blackout, além das tarifas Purin. Nas revendas compartilhadas, o custo do fornecedor continua retido.</p><button type="submit">Salvar comissão desta loja</button></form><form><label>ID da subconta<input name="subaccountId" required pattern="sacc_[A-Za-z0-9_-]+" maxlength="125" placeholder="sacc_…" value="${esc(status.subaccountId)}"></label><button type="submit">Verificar e vincular subconta</button></form>`
      : `<h2>Pix automático Blackout · PurinCash</h2><p>${status.connected ? 'Conta principal conectada. Preencha somente para atualizar a conexão.' : 'Conecte a conta principal para ativar os lojistas.'}</p><p>Comissão Blackout: 12% sobre o líquido após a tarifa Purin, sem valor fixo por venda. Saques: R$ 1,00 Blackout por solicitação, além da tarifa Purin. O vínculo de novas subcontas configura essas taxas automaticamente. O dinheiro permanece na carteira principal, atribuído às subcontas. Os lojistas consultam o saldo e solicitam saques na carteira Blackout após a habilitação.</p><details ${status.connected ? '' : 'open'}><summary>${status.connected ? 'Atualizar credenciais' : 'Configurar conexão'}</summary><p>Na PurinCash, crie uma chave de produção com Criar cobranças, Consultar cobranças e Gerenciar subcontas. Cole também o Webhook Secret da conta. A permissão Sacar de subconta é habilitada separadamente. Saques da conta principal não são necessários.</p><form><label>API Key de produção<input name="accessToken" type="password" autocomplete="off" required pattern="ps_live_[A-Za-z0-9_-]+" maxlength="520" placeholder="ps_live_…"></label><label>Webhook Secret da conta<input name="webhookSecret" type="password" autocomplete="off" required minlength="16" maxlength="512"></label><button type="submit">Validar e conectar PurinCash</button></form></details>`;
    host.insertAdjacentHTML(
      'beforeend',
      '<p class="feedback" role="status" data-purin-feedback hidden></p>',
    );
    if (!merchantId && status.connected)
      host.insertAdjacentHTML(
        'beforeend',
        `<h3>Saques das subcontas</h3><p>Para habilitar, a chave de produção precisa da permissão <strong>Sacar de subconta</strong> na PurinCash. A API enviará Pix apenas do saldo da subconta de cada lojista, após conferência e confirmação no canal em que o saque foi iniciado. O primeiro saque, os valores mínimos, as tarifas e os limites dependem da PurinCash.</p><form data-withdrawals><label class="check-label"><input name="enabled" type="checkbox" ${status.withdrawalsEnabled ? 'checked' : ''}><span>Habilitar os saques dos lojistas pelo site e Telegram</span></label><button type="submit">Salvar habilitação de saques</button></form>`,
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
      const withdrawals = form.hasAttribute('data-withdrawals');
      const policy = form.hasAttribute('data-sale-policy');
      await api(
        policy
          ? base + '/policy'
          : withdrawals
            ? base + '/withdrawals'
            : merchantId
              ? base
              : base + '/connect',
        policy
          ? { saleFeePercent: Number(data.saleFeePercent) }
          : withdrawals
            ? { enabled: data.enabled === 'on' }
            : merchantId
              ? { subaccountId: data.subaccountId }
              : data,
      );
      form.reset();
      await render();
      const feedback = host.querySelector<HTMLElement>('[data-purin-feedback]');
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = policy
          ? 'Comissão desta loja salva. O custo do fornecedor continua preservado nas revendas.'
          : withdrawals
            ? 'Habilitação de saques atualizada.'
            : merchantId
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
