type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
export type ActivationStatus = { stage: string; message: string; code: string | null };
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export async function mountHostingAdmin(host: HTMLElement, api: Api, accountId?: string) {
  try {
    if (accountId) {
      const { activation } = await api<{ activation: ActivationStatus | null }>(
        '/admin/accounts/' + accountId + '/activation',
      );
      if (!activation || !host.isConnected) return;
      host.innerHTML = `<h3>Ativação automática</h3><p>${esc(activation.message)}</p>${activation.code ? `<small>Motivo: ${esc(activation.code)}</small>` : ''}${['action_required', 'uncertain'].includes(activation.stage) ? '<button class="quiet" data-activation-retry>Conferir e retomar ativação</button>' : ''}<p role="status" data-hosting-feedback></p>`;
      host.querySelector('button')?.addEventListener('click', async () => {
        const button = host.querySelector('button')!;
        button.disabled = true;
        try {
          await api('/admin/accounts/' + accountId + '/activation/retry', {});
          await mountHostingAdmin(host, api, accountId);
        } catch {
          host.querySelector('[data-hosting-feedback]')!.textContent =
            'Não foi possível retomar. Atualize a página e confira a situação.';
          button.disabled = false;
        }
      });
      return;
    }
    const settings = await api<{ connected: boolean; enabled: boolean }>('/admin/hosting');
    if (!host.isConnected) return;
    host.innerHTML = `<h2>Hospedagem automática dos bots</h2><p>${settings.enabled ? 'Ativada. Novos envios de bots entram na fila de publicação.' : settings.connected ? 'Pausada. Os bots já publicados continuam funcionando.' : 'Conecte a Square Cloud para publicar os bots após a contratação.'}</p><p>Cada novo bot reserva 256 MB do plano. Sem memória disponível, a ativação fica pendente e o período contratado não começa.</p><details ${settings.connected ? '' : 'open'}><summary>${settings.connected ? 'Atualizar conexão' : 'Conectar Square Cloud'}</summary><form data-hosting-connect><label>Chave de API da Square Cloud<input type="password" name="apiKey" required minlength="20" maxlength="512" autocomplete="off" spellcheck="false"></label><small>Crie uma chave em Minha conta → Segurança, com account:read, apps:read, apps:write, apps:control e envs:write. A chave será armazenada cifrada no servidor.</small><label class="check-label"><input type="checkbox" name="enabled" checked><span>Ativar a criação automática de aplicativos exclusivos para novas lojas pagas.</span></label><button type="submit">Validar e conectar hospedagem</button></form></details>${settings.enabled ? '<button class="quiet" data-hosting-pause>Pausar novas ativações</button>' : ''}<p role="status" data-hosting-feedback></p>`;
    const feedback = (text: string) => {
      host.querySelector('[data-hosting-feedback]')!.textContent = text;
    };
    host.querySelector('form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement,
        data = new FormData(form),
        button = form.querySelector('button')!;
      button.disabled = true;
      button.textContent = 'Validando conexão…';
      try {
        await api('/admin/hosting', {
          apiKey: data.get('apiKey'),
          enabled: data.get('enabled') === 'on',
        });
        form.reset();
        await mountHostingAdmin(host, api);
      } catch {
        feedback('Não foi possível conectar. Confira a chave e as permissões na Square Cloud.');
        button.disabled = false;
        button.textContent = 'Validar e conectar hospedagem';
      }
    });
    host.querySelector('[data-hosting-pause]')?.addEventListener('click', async () => {
      try {
        await api('/admin/hosting/pause', {});
        await mountHostingAdmin(host, api);
      } catch {
        feedback('Não foi possível pausar. Tente novamente.');
      }
    });
  } catch {
    host.textContent = 'Não foi possível consultar a hospedagem automática. Atualize a página.';
  }
}
