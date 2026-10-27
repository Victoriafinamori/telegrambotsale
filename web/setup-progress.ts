import type { SetupProgress } from '../server/setup-progress.js';
import { setupVisibility, setupDismissed, rememberSetupDismissed } from './setup-visibility.js';
import './setup-progress.css';
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const tick = icon('<path d="m5 12 4 4L19 6"/>');
const close = icon('<path d="m6 6 12 12M6 18 18 6"/>');
const arrow = icon('<path d="M5 12h14m-6-6 6 6-6 6"/>');
const storage = () => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};
export function isSetupDismissed(scope: string) {
  return setupDismissed(scope, storage());
}

// Capture keeps these local display controls independent of the dashboard's delegation.
if (typeof document !== 'undefined')
  document.addEventListener(
    'click',
    (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        '[data-setup-control], [data-setup-step]',
      );
      const wrapper = button?.closest<HTMLElement>('[data-setup-wrapper]');
      if (!button || !wrapper) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.hasAttribute('data-setup-step')) {
        const index = button.dataset.setupStep;
        wrapper
          .querySelectorAll<HTMLButtonElement>('[data-setup-step]')
          .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        wrapper.querySelectorAll<HTMLElement>('[data-setup-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.setupPanel !== index;
        });
        wrapper
          .closest('main')
          ?.querySelectorAll<HTMLElement>('[data-setup-aux]')
          .forEach((el) => {
            el.hidden = index !== '1';
          });
        return;
      }
      const hidden = button.dataset.setupControl === 'close';
      rememberSetupDismissed(wrapper.dataset.setupScope!, hidden, storage());
      wrapper.querySelector<HTMLElement>('.setup-progress')!.hidden = hidden;
      wrapper.querySelector<HTMLElement>('.sp-closed')!.hidden = !hidden;
      wrapper
        .closest('main')
        ?.querySelectorAll<HTMLElement>('[data-setup-aux]')
        .forEach((el) => {
          el.hidden = hidden;
        });
      if (
        hidden &&
        wrapper.dataset.setupContext === 'connection' &&
        location.hash.startsWith('#/configuracao')
      ) {
        location.hash = '#/minha-loja';
        return;
      }
      const focus = hidden
        ? wrapper.querySelector<HTMLElement>('[data-setup-control="open"]')
        : wrapper.querySelector<HTMLElement>('[data-setup-step][aria-pressed="true"]');
      focus?.focus({ preventScroll: true });
    },
    true,
  );

export function renderSetupProgress(
  progress: SetupProgress,
  context: 'console' | 'connection',
  scope = 'store',
  forceOpen = false,
) {
  const visibility = setupVisibility(progress.ready, scope, forceOpen, storage());
  if (visibility === 'complete') return '';
  const current = Math.max(
    0,
    progress.ready
      ? progress.steps.length - 1
      : progress.steps.findIndex((step) => step.state === 'current'),
  );
  const action = (step: SetupProgress['steps'][number]) => {
    const next = step.action;
    if (!next) return '<span class="sp-await">Disponível depois das etapas anteriores.</span>';
    if (next.command)
      return `<button class="button-link" type="button" ${next.command === 'owner' ? 'id="connect-telegram-owner"' : context === 'console' ? 'data-action="refresh"' : 'id="refresh"'}>${esc(next.label)}${arrow}</button>`;
    return `<a class="button-link" href="${esc(next.href!)}"${next.href!.startsWith('https:') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(next.label)}${arrow}</a>`;
  };
  return `<div data-setup-wrapper data-setup-scope="${esc(scope)}" data-setup-context="${context}"><div class="sp-closed" ${visibility === 'closed' ? '' : 'hidden'}><span>Continue a configuração quando quiser.</span><button class="quiet" type="button" data-setup-control="open">Retomar configuração ${arrow}</button></div><section class="setup-progress" aria-label="Configuração da sua loja" ${visibility === 'closed' ? 'hidden' : ''}><div class="sp-heading"><div><h2>${progress.ready ? 'Tudo pronto para começar' : 'Sua loja, passo a passo'}</h2><p>${progress.completed} de ${progress.total} etapas concluídas. ${progress.ready ? 'Sua configuração básica está completa.' : 'Avance no seu ritmo. O que você salva fica na sua conta.'}</p></div><button class="quiet sp-close" type="button" data-setup-control="close" aria-label="Fechar acompanhamento da configuração" title="Fechar acompanhamento">${close}<span>Fechar</span></button></div><ol class="sp-rail" aria-label="Etapas da configuração">${progress.steps.map((step, index) => `<li class="sp-${step.state}" ${step.state === 'current' ? 'aria-current="step"' : ''}><button type="button" class="sp-step-button" data-setup-step="${index}" aria-pressed="${index === current}" aria-label="${esc(step.title)}: ${step.state === 'done' ? 'concluído' : step.state === 'current' ? 'próximo passo' : 'pendente'}"><span class="sp-marker">${step.state === 'done' ? tick : index + 1}</span><span class="sp-step-title">${esc(step.title)}</span></button></li>`).join('')}</ol>${progress.steps.map((step, index) => `<section class="sp-detail" data-setup-panel="${index}" ${index === current ? '' : 'hidden'} aria-label="${esc(step.title)}"><div class="sp-detail-heading"><h3>${esc(step.title)}</h3><span class="sp-state">${step.state === 'done' ? 'Concluído' : step.state === 'current' ? 'Próxima ação' : 'Pendente'}</span></div><p>${esc(step.detail)}</p>${step.id === 'store' ? `<ul class="sp-checks">${progress.checks.map((check) => `<li><span>${check.done ? tick : '<span class="sp-check-empty" aria-hidden="true"></span>'}<span class="sp-sr">${check.done ? 'Concluído:' : 'Pendente:'}</span>${esc(check.title)}</span>${step.action ? `<a href="${esc(check.href)}">${check.done ? 'Revisar' : 'Configurar'}<span class="sp-sr"> ${esc(check.title)}</span></a>` : ''}</li>`).join('')}</ul>` : ''}<div class="sp-action">${action(step)}${(step.id === 'store' || step.id === 'ready') && step.action ? '<a class="sp-test-link" href="#/gestao?section=test">Testar uma compra sem cobrança</a>' : ''}</div></section>`).join('')}<p class="sp-note">${progress.ready ? 'Confira o atendimento e faça uma simulação antes de divulgar sua loja.' : esc(progress.message)}</p></section></div>`;
}
