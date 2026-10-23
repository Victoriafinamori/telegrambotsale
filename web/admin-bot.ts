import type { BotSetup } from '../server/bot-onboarding.js';
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const activationLabels = {
  pending: 'Aguardando ativação',
  configuring: 'Em configuração',
  changes_requested: 'Correção solicitada',
  active: 'Ativação confirmada',
};
export function adminBotCard(
  setup: BotSetup,
  approved: boolean,
  date: (v: Date | string | null) => string,
) {
  const actionable = approved && setup.submitted_at && setup.activation_status !== 'active';
  return `<section class="setup-status"><div class="card-heading"><h3>Bot do cliente</h3><span class="badge">${setup.submitted_at ? activationLabels[setup.activation_status] : 'Rascunho do lojista'}</span></div><dl><div><dt>Bot</dt><dd>@${esc(setup.bot_username)}</dd></div><div><dt>ID do bot</dt><dd>${esc(setup.bot_id)}</dd></div><div><dt>ID pessoal do cliente</dt><dd>${esc(setup.telegram_user_id)}</dd></div><div><dt>Dados enviados</dt><dd>${setup.submitted_at ? date(setup.submitted_at) : 'Ainda não enviados'}</dd></div>${setup.activated_at ? `<div><dt>Ativação confirmada em</dt><dd>${date(setup.activated_at)}</dd></div><div><dt>Aplicativo Square Cloud</dt><dd>${esc(setup.deployment_reference)}</dd></div>` : ''}</dl>${setup.review_note ? `<p class="warning">${esc(setup.review_note)}</p>` : ''}<div class="inline-actions">${approved && setup.submitted_at ? '<button class="quiet" id="request-bot-token">Consultar token protegido</button>' : ''}${actionable ? `${setup.activation_status === 'pending' ? '<button id="start-bot-configuration">Iniciar configuração</button>' : setup.activation_status === 'configuring' ? '<button id="confirm-bot-activation">Confirmar bot ativo</button>' : ''}<button class="quiet" id="request-bot-changes">Solicitar correção</button>` : ''}</div><small>${setup.activation_status === 'active' ? 'Ativação confirmada manualmente pelo administrador. O funcionamento na Square Cloud ainda não é monitorado por este painel.' : 'Instale e teste o bot no aplicativo exclusivo deste cliente na Square Cloud antes de confirmar a ativação.'}</small></section>`;
}
