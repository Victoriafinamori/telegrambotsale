import type { SetupProgress } from '../server/setup-progress.js';
import './setup-progress.css';
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const tick =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
export function renderSetupProgress(progress: SetupProgress, context: 'console' | 'connection') {
  const action = (step: SetupProgress['steps'][number]) => {
    const next = step.action;
    if (!next) return '<span class="sp-await">Aguardando etapa anterior</span>';
    const className = step.state === 'current' ? 'button-link' : 'button-link quiet';
    if (next.command)
      return `<button class="${className}" type="button" ${next.command === 'owner' ? 'id="connect-telegram-owner"' : context === 'console' ? 'data-action="refresh"' : 'id="refresh"'}>${esc(next.label)}</button>`;
    return `<a class="${className}" href="${esc(next.href!)}"${next.href!.startsWith('https:') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(next.label)}</a>`;
  };
  return `<section class="setup-progress" aria-label="Configuração da sua loja"><div class="sp-heading"><h2>${progress.ready ? 'Sua loja está pronta' : 'Vamos preparar sua loja'}</h2><span>${progress.completed} de ${progress.total} etapas concluídas</span></div><p class="sp-intro">${esc(progress.message)}</p><ol class="sp-steps">${progress.steps.map((step, index) => `<li class="sp-step sp-${step.state}"${step.state === 'current' ? ' aria-current="step"' : ''}><span class="sp-marker" aria-hidden="true">${step.state === 'done' ? tick : index + 1}</span><div class="sp-body"><div class="sp-step-heading"><h3>${esc(step.title)}</h3><span class="sp-state">${step.state === 'done' ? 'Concluído' : step.state === 'current' ? 'Próximo passo' : 'Pendente'}</span></div><p>${esc(step.detail)}</p>${step.id === 'store' ? `<ul class="sp-checks">${progress.checks.map((check) => `<li><span>${check.done ? tick : '<span class="sp-check-empty" aria-hidden="true"></span>'}<span class="sp-sr">${check.done ? 'Concluído:' : 'Pendente:'}</span>${esc(check.title)}</span>${step.action ? `<a href="${esc(check.href)}">${check.done ? 'Revisar' : 'Configurar'}<span class="sp-sr"> ${esc(check.title)}</span></a>` : ''}</li>`).join('')}</ul>` : ''}<div class="sp-action">${action(step)}</div></div></li>`).join('')}</ol><p class="sp-note">O progresso considera somente alterações salvas. “Loja pronta” indica a configuração básica; uma compra de teste ainda é recomendada.</p></section>`;
}
