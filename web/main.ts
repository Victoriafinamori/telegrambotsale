import './style.css';
import './landing.css';
import { landingPage, publicContactUrl } from './landing.js';
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  initializeAuth,
  inMemoryPersistence,
  browserSessionPersistence,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  reload,
  signOut,
  type Auth,
} from 'firebase/auth';
import type { MerchantAccount, AdminMerchantAccount } from '../server/types.js';
import type { BotSetup } from '../server/bot-onboarding.js';
import { botGuide } from './onboarding.js';
import { adminBotCard, activationLabels } from './admin-bot.js';
import { mountMerchantConsole } from './merchant-console.js';
import { mountPixCheckout } from './pix-checkout.js';
const app = document.querySelector<HTMLDivElement>('#app')!;
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (c: number) =>
    (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  date = (v: string | Date | null) =>
    v
      ? new Date(v).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : 'Ainda não iniciou';
type Me = {
  user: { uid: string; email: string };
  role: 'platform' | 'merchant' | 'unassigned';
  account: MerchantAccount | null;
  adminMfaRequired?: boolean;
};
type PublicConfig = {
  firebase: FirebaseOptions;
  emulatorHost: string | null;
  authMode?: 'cookie' | 'bearer';
};
class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let csrf = '',
  me: Me | null = null,
  accounts: AdminMerchantAccount[] = [],
  selected: string | null = null,
  inviteLink = '',
  authMode = 'login',
  authEmail = '',
  feedback = '',
  section = 'accounts',
  offset = 0,
  busy = false;
let botSetup: BotSetup | null = null,
  adminBotSetup: BotSetup | null = null,
  guideStep = 1;
type RuntimeStatus = { provisioned: boolean; online: boolean; ownerVerified: boolean };
let botRuntime: RuntimeStatus | null = null;
let adminRuntime: RuntimeStatus | null = null;
let adminProof = '',
  mfaSecret = '';
function serviceUrl(path: string) {
  const raw = import.meta.env.VITE_API_ORIGIN;
  if (!raw) return path;
  const url = new URL(raw);
  if (
    url.origin !== raw ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    throw Error('Invalid API origin');
  return url.origin + path;
}
const inviteToken = () => new URLSearchParams(location.hash.split('?')[1] || '').get('token');
async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const bearer = config?.authMode === 'bearer';
  if (!bearer && body !== undefined && !csrf)
    csrf = (
      await fetch(serviceUrl('/api/security/csrf'), {
        credentials: 'same-origin',
        cache: 'no-store',
      }).then((r) => r.json())
    ).token;
  const idToken = bearer && auth.currentUser ? await auth.currentUser.getIdToken() : '';
  const response = await fetch(serviceUrl('/api' + path), {
    method: body === undefined ? 'GET' : 'POST',
    credentials: bearer ? 'omit' : 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', ...(!bearer ? { 'X-CSRF-Token': csrf } : {}) }),
      ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}),
      ...(adminProof ? { 'X-Admin-MFA': adminProof } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    if (value.code === 'CSRF_REJECTED' && retry) {
      csrf = '';
      return api(path, body, false);
    }
    throw new ApiError(value.code, value.message || 'Não foi possível concluir.', response.status);
  }
  return value as T;
}
let config: PublicConfig | null = null;
let auth: Auth;
let servicesReady = false;
async function ensureServices() {
  if (servicesReady) return;
  const response = await fetch(serviceUrl('/api/config'), { cache: 'no-store' });
  if (!response.ok) throw new Error('Server unavailable');
  config = (await response.json()) as PublicConfig;
  auth = initializeAuth(initializeApp(config.firebase), {
    persistence: config.authMode === 'bearer' ? browserSessionPersistence : inMemoryPersistence,
  });
  if (config.emulatorHost)
    connectAuthEmulator(auth, 'http://' + config.emulatorHost, { disableWarnings: true });
  await auth.authStateReady();
  servicesReady = true;
}
function renderLanding() {
  document.title = 'Blackout Create · Seu bot de vendas no Telegram';
  if (!app.querySelector('.landing-page'))
    app.innerHTML = landingPage(publicContactUrl(import.meta.env.VITE_CONTACT_URL), Boolean(me));
  const anchor = location.hash.slice(1);
  if (['experiencia', 'como-funciona', 'duvidas', 'contratar', 'conteudo'].includes(anchor)) {
    requestAnimationFrame(() =>
      document.getElementById(anchor)?.scrollIntoView({ block: 'start' }),
    );
  } else window.scrollTo(0, 0);
}
function renderPortalUnavailable() {
  shell(
    '<main class="auth-shell"><section class="card"><span class="eyebrow">Área do cliente</span><h1>Acesso temporariamente indisponível</h1><p>Não foi possível conectar à área do cliente. Tente novamente em instantes.</p><div class="inline-actions"><button id="retry-services">Tentar novamente</button><a class="button-link" href="#/">Voltar ao site</a></div></section></main>',
  );
}
const labels = {
  pending: 'Aguardando aprovação',
  approved: 'Acesso liberado',
  suspended: 'Acesso suspenso',
};
const brand =
  '<a class="brand" href="#/"><img src="/brand.webp" alt=""><span>Blackout <small>Create</small></span></a>';
function flash(value: string) {
  feedback = value;
  const box = document.querySelector<HTMLElement>('#feedback');
  if (box) {
    box.textContent = value;
    box.hidden = !value;
    box.scrollIntoView({ block: 'nearest' });
  }
}
function shell(content: string) {
  document.title = 'Blackout Create · Área do cliente';
  app.innerHTML = `<header>${brand}<div class="header-actions"><button class="quiet" id="theme" type="button" aria-label="Alternar tema">◐</button>${me ? '<button class="quiet" id="logout">Sair</button>' : ''}</div></header>${config?.emulatorHost ? '<div class="local-banner"><b>Ambiente local de testes</b> · Sem pagamentos ou bots reais. Não informe dados reais.</div>' : ''}<div id="feedback" class="feedback" role="status" ${feedback ? '' : 'hidden'}>${esc(feedback)}</div>${content}<footer>Blackout Create · <a href="#/">Início</a></footer>`;
}
function renderAuth() {
  const signup = authMode === 'signup',
    reset = authMode === 'reset',
    verify = authMode === 'verify';
  shell(
    `<main class="auth-shell"><section class="card auth-card"><span class="eyebrow">${inviteToken() ? 'Convite de acesso' : 'Sua loja no Telegram'}</span><h1>${verify ? 'Confirme seu e-mail' : reset ? 'Recuperar acesso' : signup ? 'Crie seu acesso' : 'Bem-vindo de volta'}</h1><p>${verify ? 'Abra o link de confirmação enviado ao seu e-mail. Depois, continue aqui.' : reset ? 'Enviaremos as instruções de recuperação se houver uma conta com esse e-mail.' : signup ? 'Use o mesmo e-mail informado na contratação.' : 'Entre para acompanhar a ativação do bot e sua assinatura.'}</p>${verify ? `<div class="inline-actions"><button id="verified">Já confirmei meu e-mail</button><button class="quiet" id="resend">Reenviar confirmação</button></div><button class="text-button" data-auth-mode="login">Voltar para entrar</button>` : `<form id="auth-form"><label for="email">E-mail</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(authEmail)}">${reset ? '' : `<label for="password">Senha</label><input id="password" name="password" type="password" minlength="${signup ? 12 : 1}" maxlength="128" required autocomplete="${signup ? 'new-password' : 'current-password'}">${signup ? '<small>Use pelo menos 12 caracteres e uma senha exclusiva.</small>' : ''}`}<button type="submit">${reset ? 'Enviar instruções' : signup ? 'Criar acesso' : 'Entrar'}</button></form><div class="auth-links"><button class="text-button" data-auth-mode="${signup || reset ? 'login' : 'signup'}">${signup || reset ? 'Já tenho acesso' : 'Primeiro acesso? Criar conta'}</button>${!reset && !signup ? '<button class="text-button" data-auth-mode="reset">Esqueci minha senha</button>' : ''}</div>`}${config?.emulatorHost && !verify ? '<details class="local-accounts"><summary>Contas locais de teste</summary><p>Senha: <code>BlackoutLocal!2026</code></p><button class="quiet" data-local-account="admin@blackout.test">Administrador local</button><button class="quiet" data-local-account="lojista@blackout.test">Lojista local</button></details>' : ''}<small class="auth-note">A contratação pode ocorrer pelo WhatsApp, Telegram, Discord ou outro canal. A Blackout Create cadastra sua loja e libera o convite.</small></section></main>`,
  );
}
function accountRow(a: AdminMerchantAccount) {
  return `<button class="account-row" data-account="${esc(a.id)}"><span><b>${esc(a.store_name)}</b><small>${esc(a.name)} · ${esc(a.email)}</small></span><span class="badge ${a.access_status}">${a.access_status === 'suspended' ? labels.suspended : !a.purchase_confirmed_at ? 'Conferir contratação' : !a.firebase_uid ? 'Convite pendente' : a.bot_submitted_at && a.bot_activation_status ? activationLabels[a.bot_activation_status] : labels[a.access_status]}</span><span aria-hidden="true">›</span></button>`;
}
function adminView() {
  const a = accounts.find((a) => a.id === selected);
  shell(
    `<main class="workspace"><div class="page-heading"><div><span class="eyebrow">Administração da plataforma</span><h1>Lojistas</h1></div><button id="new-account">Adicionar lojista</button></div><nav class="tabs"><button data-section="accounts" class="${section === 'accounts' ? 'active' : ''}">Lojistas</button><button data-section="activations" class="${section === 'activations' ? 'active' : ''}">Ativações</button><button data-section="audit" class="${section === 'audit' ? 'active' : ''}">Histórico</button></nav>${section === 'audit' ? '<section class="card" id="audit-list">Carregando histórico…</section>' : `<section class="card compact">${accounts.map(accountRow).join('') || `<div class="empty"><b>${section === 'activations' ? 'Nenhuma ativação pendente' : 'Comece pelo primeiro lojista'}</b><p>${section === 'activations' ? 'Os bots enviados e liberados aparecerão aqui.' : 'Cadastre a contratação recebida e gere o convite de acesso.'}</p></div>`}</section><div class="pagination"><button class="quiet" id="previous" ${offset === 0 ? 'disabled' : ''}>Anterior</button><span>Página ${offset / 50 + 1}</span><button class="quiet" id="next" ${accounts.length < 50 ? 'disabled' : ''}>Próxima</button></div>`}${a && section !== 'audit' ? `<section class="card detail"><div class="card-heading"><h2>${esc(a.store_name)}</h2><span class="badge ${a.access_status}">${labels[a.access_status]}</span></div><dl><div><dt>Lojista</dt><dd>${esc(a.name)}</dd></div><div><dt>E-mail</dt><dd>${esc(a.email)}</dd></div><div><dt>Canal da contratação</dt><dd>${esc(a.channel)}</dd></div><div><dt>Referência</dt><dd>${esc(a.reference || 'Não informada')}</dd></div><div><dt>Mensalidade contratada</dt><dd>${money(a.price_cents)}</dd></div><div><dt>Início da mensalidade</dt><dd>${date(a.billing_started_at)}</dd></div><div><dt>Vencimento</dt><dd>${date(a.paid_through)}</dd></div></dl><p class="note">Liberar o acesso ao painel não ativa o bot. O ciclo mensal começa somente após a ativação efetiva do bot.</p>${a.suspension_reason ? `<p class="warning">${esc(a.suspension_reason)}</p>` : ''}${adminBotSetup ? adminBotCard(adminBotSetup, a.access_status === 'approved', date) : ''}<div class="inline-actions">${!a.purchase_confirmed_at ? '<button id="confirm-purchase">Confirmar contratação</button>' : ''}${a.purchase_confirmed_at && !a.firebase_uid && a.access_status !== 'suspended' ? '<button id="issue-invite">Gerar convite</button>' : ''}${a.firebase_uid && a.access_status === 'pending' ? '<button id="approve">Liberar acesso ao painel</button>' : ''}${a.access_status !== 'suspended' ? '<button class="quiet" id="suspend">Suspender acesso ao painel</button>' : '<button class="quiet" id="restore">Remover suspensão</button>'}</div>${inviteLink ? `<div class="invite-box"><label for="invite-link">Convite · copie e envie pelo canal da contratação</label><input id="invite-link" value="${esc(inviteLink)}" readonly><button class="quiet" id="copy-invite">Copiar convite</button><small>Uso único, válido por 7 dias e vinculado ao e-mail cadastrado. Gerar outro invalida o anterior.</small></div>` : ''}</section>` : ''}</main>`,
  );
  if (a && section !== 'audit') {
    const details = document.querySelector('.detail');
    if (adminRuntime)
      details?.insertAdjacentHTML(
        'beforeend',
        `<section class="setup-status"><h3>Conexão do bot</h3><p>${adminRuntime.provisioned ? (adminRuntime.online ? 'Aplicativo conectado.' : 'Aplicativo aguardando conexão.') : 'Aplicativo ainda não preparado.'} ${adminRuntime.ownerVerified ? 'Responsável confirmado no Telegram.' : 'Responsável ainda precisa confirmar sua conta pelo site.'}</p></section>`,
      );
    if (a.billing_started_at)
      details?.insertAdjacentHTML(
        'beforeend',
        '<button class="quiet" id="renew-subscription">Registrar renovação mensal</button>',
      );
  }
  if (me?.account)
    document
      .querySelector('.workspace .page-heading')
      ?.insertAdjacentHTML(
        'beforeend',
        '<a class="button-link" href="#/minha-loja">Abrir minha loja</a>',
      );
}
function merchantView() {
  const a = me?.account;
  if (!a) {
    shell(
      '<main class="auth-shell"><section class="card"><span class="eyebrow">Seu acesso</span><h1>Conta criada</h1><p>Use o convite enviado pela Blackout Create para vincular sua loja. Criar uma conta não libera uma contratação.</p></section></main>',
    );
    return;
  }
  const approved = a.access_status === 'approved';
  shell(
    `<main class="merchant-shell"><div class="page-heading"><div><span class="eyebrow">${esc(a.store_name)}</span><h1>${botSetup?.activation_status === 'active' ? 'Sua loja' : 'Primeiros passos'}</h1></div><span class="badge ${a.access_status}">${labels[a.access_status]}</span></div>${approved ? `<p class="welcome-note">${botSetup?.activation_status === 'active' ? 'Acompanhe sua ativação e os dados da contratação.' : 'Seu acesso foi liberado. Siga as etapas para preparar seu bot.'}</p>${botGuide(botSetup, guideStep, Boolean(config?.emulatorHost))}` : `<section class="card"><h2>${a.access_status === 'suspended' ? 'Acesso suspenso' : 'Sua loja está em análise'}</h2><p>${a.access_status === 'suspended' ? esc(a.suspension_reason || 'Fale com a Blackout Create pelo canal da contratação.') : 'Sua conta já está vinculada. Após a aprovação, você terá um assistente para criar o bot, informar seu token e ID do Telegram e solicitar a ativação na Square Cloud.'}</p><p class="note">A mensalidade começa somente após a ativação efetiva do bot.</p><button class="quiet" id="refresh">Atualizar situação</button></section>`}<details class="card contract-details"><summary>Sua contratação · ${a.reference === 'PILOTO INTERNO BLACKOUT / SEM COBRANCA REAL' ? 'Piloto interno sem cobrança' : money(a.price_cents)}</summary><dl><div><dt>Início do ciclo</dt><dd>${date(a.billing_started_at)}</dd></div><div><dt>Vencimento</dt><dd>${date(a.paid_through)}</dd></div><div><dt>Contato da contratação</dt><dd>${esc(a.channel)}</dd></div><div><dt>Conta</dt><dd>${esc(me!.user.email)}</dd></div></dl></details></main>`,
  );
  if (me?.role === 'platform')
    document
      .querySelector('.header-actions')
      ?.insertAdjacentHTML(
        'afterbegin',
        '<a class="button-link quiet" href="#/conta">Administração</a>',
      );
  if (approved && botRuntime?.provisioned) {
    document
      .querySelector('main.merchant-shell .page-heading')
      ?.insertAdjacentHTML(
        'beforeend',
        '<a class="button-link" href="#/gestao">Gerenciar minha loja</a>',
      );
    document
      .querySelector('main.merchant-shell')
      ?.insertAdjacentHTML(
        'beforeend',
        `<section class="card"><span class="eyebrow">Conexão com o Telegram</span><h2>${botRuntime.ownerVerified ? 'Responsável confirmado' : 'Confirme que este bot é seu'}</h2><p>Aplicativo do bot: <b>${botRuntime.online ? 'conectado' : 'aguardando conexão'}</b>.</p>${botRuntime.ownerVerified ? '<p>Abra seu bot e envie <code>/admin</code> para configurar produtos, estoque, fotos, cupons, suporte, pagamentos e avisos. No bot, você também acompanha pedidos, comprovantes e estatísticas.</p>' : '<p>Confirme sua conta pessoal no bot para liberar o menu administrativo da sua loja.</p><button id="connect-telegram-owner">Confirmar minha conta no Telegram</button>'}</section>`,
      );
  }
}
async function load() {
  const route = location.hash.split('?')[0];
  if (route.startsWith('#/pagar/')) {
    await mountPixCheckout(app, route, async (path, body) => {
      const response = await fetch(serviceUrl('/api/payments/checkout/' + path), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.message ?? value.error?.message ?? 'Pagamento indisponível. Tente novamente.',
        );
      return value;
    });
    return;
  }
  if (
    !inviteToken() &&
    !['#/entrar', '#/conta', '#/convite', '#/minha-loja', '#/gestao', '#/configuracao'].includes(
      route,
    )
  ) {
    renderLanding();
    return;
  }
  try {
    await ensureServices();
  } catch {
    renderPortalUnavailable();
    return;
  }
  try {
    me = await api<Me>('/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) me = null;
    else throw e;
  }
  const token = inviteToken();
  if (token) {
    const info = await api<{ storeName: string; emailHint: string }>('/invitations/inspect', {
      token,
    });
    if (!me) {
      renderAuth();
      document.querySelector('.auth-card>p')!.textContent =
        `Convite para ${info.storeName}. Entre ou crie sua conta com o e-mail cadastrado (${info.emailHint}).`;
      return;
    }
    shell(
      `<main class="auth-shell"><section class="card"><span class="eyebrow">Convite de acesso</span><h1>${esc(info.storeName)}</h1><p>Você está conectado como ${esc(me.user.email)}. O convite deve corresponder ao e-mail cadastrado na contratação.</p><button id="accept-invite">Vincular minha loja</button></section></main>`,
    );
    return;
  }
  if (!me) {
    renderAuth();
    return;
  }
  const openManagement =
    route === '#/gestao' ||
    (route === '#/minha-loja' &&
      me.account?.access_status === 'approved' &&
      (await api<{ runtime: RuntimeStatus | null }>('/store/runtime')).runtime?.provisioned);
  if (openManagement) {
    if (me.account?.access_status !== 'approved') {
      merchantView();
      return;
    }
    shell(
      '<main id="merchant-console-host"><p class="welcome-note">Carregando sua loja…</p></main>',
    );
    try {
      await mountMerchantConsole(
        document.querySelector<HTMLElement>('#merchant-console-host')!,
        api,
        async (path) => {
          const user = auth.currentUser,
            token = config?.authMode === 'bearer' && user ? await user.getIdToken() : '';
          const response = await fetch(serviceUrl('/api' + path), {
            cache: 'no-store',
            credentials: config?.authMode === 'bearer' ? 'omit' : 'same-origin',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
          });
          if (!response.ok)
            throw new Error(
              'Não foi possível abrir o arquivo. Confira sua sessão e tente novamente.',
            );
          return response.blob();
        },
      );
    } catch (error) {
      shell(
        `<main class="auth-shell"><section class="card"><h1>Não foi possível abrir sua loja</h1><p>${esc(error instanceof Error ? error.message : 'Confira sua conexão e tente novamente.')}</p><div class="inline-actions"><button id="retry-services">Tentar novamente</button><a class="button-link quiet" href="#/configuracao">Ver ativação e conexão</a></div></section></main>`,
      );
    }
    return;
  }
  if (me.role === 'platform' && route !== '#/minha-loja' && route !== '#/configuracao') {
    if (me.adminMfaRequired) {
      await renderAdminMfa();
      return;
    }
    accounts = (
      await api<{ accounts: AdminMerchantAccount[] }>(
        '/admin/accounts?offset=' +
          offset +
          '&queue=' +
          (section === 'activations' ? 'activation' : 'all'),
      )
    ).accounts;
    adminBotSetup = selected
      ? (await api<{ setup: BotSetup | null }>('/admin/accounts/' + selected + '/bot-setup')).setup
      : null;
    adminRuntime = selected
      ? (
          await api<{ runtime: typeof adminRuntime }>(
            '/admin/accounts/' + selected + '/bot-runtime',
          )
        ).runtime
      : null;
    adminView();
    if (section === 'audit') {
      const value = await api<{ events: { action: string; created_at: string }[] }>('/admin/audit');
      document.querySelector('#audit-list')!.innerHTML =
        value.events
          .map(
            (v) =>
              `<div class="audit-row"><b>${esc(v.action)}</b><small>${date(v.created_at)}</small></div>`,
          )
          .join('') || '<p>Sem eventos.</p>';
    }
  } else {
    botSetup =
      me.account?.access_status === 'approved'
        ? (await api<{ setup: BotSetup | null }>('/onboarding')).setup
        : null;
    guideStep =
      botSetup?.activation_status === 'changes_requested'
        ? 2
        : botSetup?.submitted_at
          ? 4
          : botSetup
            ? 3
            : 1;
    botRuntime =
      me.account?.access_status === 'approved'
        ? (await api<{ runtime: typeof botRuntime }>('/store/runtime')).runtime
        : null;
    merchantView();
  }
}
async function renderAdminMfa() {
  const status = await api<{ enabled: boolean; available: boolean }>('/security/admin-mfa/status');
  let enrollment = '';
  if (mfaSecret) {
    let qr = '';
    try {
      const { authenticatorQr } = await import('./authenticator-qr.js');
      qr = await authenticatorQr(mfaSecret, me!.user.email);
    } catch {
      // Keep manual enrollment available if this browser cannot render a QR.
    }
    enrollment = `${qr ? `<ol class="mfa-steps"><li>No celular, abra o <b>Google Authenticator</b>.</li><li>Toque em <b>+</b>, escolha <b>Ler QR Code</b> e aponte para a imagem abaixo.</li><li>Digite no site os <b>6 números</b> que aparecerem no aplicativo.</li></ol><img id="admin-mfa-qr" class="mfa-qr" src="${esc(qr)}" width="256" height="256" alt="QR Code para cadastrar a Blackout Create no autenticador"><p class="mfa-qr-caption">Escaneie pelo aplicativo autenticador do celular.</p>` : '<p>Adicione uma conta no seu aplicativo autenticador usando a chave abaixo.</p>'}<details class="mfa-manual"${qr ? '' : ' open'}><summary>Não consigo escanear</summary><p>No aplicativo, escolha <b>Inserir chave de configuração</b>. Nome: <b>Blackout Create</b>. Tipo: <b>Baseado no tempo</b>.</p><label for="mfa-secret">Chave do autenticador · guarde com segurança</label><input id="mfa-secret" value="${esc(mfaSecret)}" readonly autocomplete="off" spellcheck="false"><small>Conta: ${esc(me!.user.email)}. Também funciona com Microsoft Authenticator e outros aplicativos TOTP.</small></details>`;
  }
  shell(
    `<main class="auth-shell"><section class="card mfa-card"><span class="eyebrow">Proteção do administrador</span><h1>${mfaSecret ? 'Escaneie e confirme' : 'Confirme seu acesso'}</h1>${!status.available ? '<p>O segundo fator ainda precisa ser configurado no servidor. Fale com o responsável pela implantação.</p>' : status.enabled || mfaSecret ? `${enrollment}${mfaSecret ? '' : '<p>Abra a conta <b>Blackout Create</b> no seu aplicativo autenticador e digite o código atual.</p>'}<form id="mfa-form"><label for="mfa-code">Código de 6 dígitos</label><input id="mfa-code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" required><button type="submit">Confirmar acesso</button></form>` : '<p>Vamos conectar o Google Authenticator do seu celular. Na próxima tela, basta escanear um QR Code.</p><button id="enroll-admin-mfa">Configurar autenticador</button>'}</section></main>`,
  );
}
function dialog(title: string, content: string) {
  document.querySelector('dialog')?.remove();
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="card-heading"><h2>${esc(title)}</h2><button class="quiet" type="button" id="close-dialog" aria-label="Fechar">✕</button></div>${content}<p id="dialog-feedback" class="feedback" role="alert" hidden></p>`;
  document.body.append(d);
  d.addEventListener('close', () => {
    d.querySelectorAll('input').forEach((input) => {
      input.value = '';
    });
    d.remove();
  });
  d.showModal();
}
async function task(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  feedback = '';
  const previous = document.querySelector<HTMLElement>('#feedback');
  if (previous) {
    previous.textContent = '';
    previous.hidden = true;
  }
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    const message = e instanceof ApiError ? e.message : firebaseMessage(e);
    const inDialog = document.querySelector<HTMLElement>('#dialog-feedback');
    if (inDialog) {
      inDialog.hidden = false;
      inDialog.textContent = message;
    } else flash(message);
  } finally {
    busy = false;
    buttons.forEach((b) => {
      if (b.isConnected) b.disabled = false;
    });
  }
}
function firebaseMessage(e: unknown) {
  const code = (e as { code?: string })?.code || '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(code))
    return 'Confira o e-mail e a senha.';
  if (code === 'auth/email-already-in-use')
    return 'Não foi possível criar a conta. Tente entrar ou recuperar seu acesso.';
  if (code === 'auth/too-many-requests') return 'Muitas tentativas. Aguarde e tente novamente.';
  if (code === 'auth/weak-password')
    return 'Use uma senha mais forte, com pelo menos 12 caracteres.';
  if (code === 'auth/network-request-failed')
    return 'Não foi possível conectar. Confira sua conexão e tente novamente.';
  return 'Não foi possível concluir. Tente novamente.';
}
async function exchange() {
  const user = auth.currentUser;
  if (!user) throw new ApiError('LOGIN_REQUIRED', 'Entre novamente para continuar.', 401);
  await reload(user);
  if (!user.emailVerified) {
    authMode = 'verify';
    renderAuth();
    return;
  }
  const idToken = await user.getIdToken(true);
  await api('/auth/session', { idToken });
  if (config?.authMode !== 'bearer') await signOut(auth);
  authMode = 'login';
  const check = await api<Me>('/me');
  me = check;
  feedback = '';
  if (!inviteToken()) history.replaceState(null, '', location.pathname + '#/conta');
  await load();
}
document.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  if (
    ![
      'auth-form',
      'registration-form',
      'suspend-form',
      'bot-setup-form',
      'bot-activation-form',
      'bot-changes-form',
      'mfa-form',
      'renew-form',
    ].includes(form.id)
  )
    return;
  event.preventDefault();
  void task(async () => {
    const fields = new FormData(form);
    if (form.id === 'renew-form') {
      await api('/admin/accounts/' + selected + '/renew', {
        requestId: String(fields.get('requestId')),
        paymentConfirmed: fields.get('paymentConfirmed') === 'on',
      });
      document.querySelector('dialog')?.remove();
      await load();
      flash('Renovação mensal registrada.');
    } else if (form.id === 'mfa-form') {
      const code = String(fields.get('code') || '');
      (form.querySelector('[name=code]') as HTMLInputElement).value = '';
      const result = await api<{ proof: string }>('/security/admin-mfa/verify', { code });
      adminProof = result.proof;
      mfaSecret = '';
      await load();
    } else if (form.id === 'bot-activation-form' || form.id === 'bot-changes-form') {
      if (!adminBotSetup || !selected) throw new Error('Missing bot');
      const base = '/admin/accounts/' + selected + '/bot-setup/';
      if (form.id === 'bot-activation-form') {
        await api(base + 'activate', {
          revision: Number(fields.get('revision')),
          deploymentReference: String(fields.get('deploymentReference') || ''),
          botTested: fields.get('botTested') === 'on',
          ownerIdConfirmed: fields.get('ownerIdConfirmed') === 'on',
        });
      } else {
        await api(base + 'review', {
          action: 'request_changes',
          revision: Number(fields.get('revision')),
          note: String(fields.get('note') || ''),
        });
      }
      document.querySelector('dialog')?.remove();
      await load();
      flash(
        form.id === 'bot-activation-form'
          ? 'Ativação confirmada. O período mensal começou agora.'
          : 'Correção solicitada. O cliente verá o motivo no assistente.',
      );
    } else if (form.id === 'bot-setup-form') {
      const input = form.querySelector<HTMLInputElement>('[name=botToken]')!;
      const botToken = String(fields.get('botToken') || '').trim();
      input.value = '';
      fields.delete('botToken');
      botSetup = (
        await api<{ setup: BotSetup }>('/onboarding', {
          botToken,
          telegramUserId: String(fields.get('telegramUserId') || '').trim(),
        })
      ).setup;
      guideStep = 3;
      merchantView();
      document.querySelector('#guide-content')?.scrollIntoView({ block: 'start' });
    } else if (form.id === 'auth-form') {
      authEmail = String(fields.get('email') || '').trim();
      const password = String(fields.get('password') || '');
      const input = form.querySelector<HTMLInputElement>('[name=password]');
      if (input) input.value = '';
      if (authMode === 'reset') {
        try {
          await sendPasswordResetEmail(auth, authEmail);
        } catch (e) {
          if (!['auth/user-not-found', 'auth/invalid-email'].includes((e as { code: string }).code))
            throw e;
        }
        flash('Se houver uma conta com esse e-mail, você receberá as instruções.');
        return;
      }
      if (authMode === 'signup') {
        await createUserWithEmailAndPassword(auth, authEmail, password);
        await sendEmailVerification(auth.currentUser!, { url: location.origin });
        authMode = 'verify';
        renderAuth();
        return;
      }
      await signInWithEmailAndPassword(auth, authEmail, password);
      if (!auth.currentUser!.emailVerified) {
        authMode = 'verify';
        renderAuth();
        return;
      }
      await exchange();
    } else if (form.id === 'registration-form') {
      const value = {
        name: String(fields.get('name')),
        storeName: String(fields.get('storeName')),
        email: String(fields.get('email')),
        channel: String(fields.get('channel')),
        reference: String(fields.get('reference')),
        priceCents: Math.round(Number(fields.get('price')) * 100),
      };
      const result = await api<{ account: MerchantAccount }>('/admin/accounts', value);
      selected = result.account.id;
      inviteLink = '';
      document.querySelector('dialog')!.close();
      document.querySelector('dialog')!.remove();
      await load();
      flash('Lojista cadastrado. Confira a contratação antes de gerar o convite.');
    } else {
      await api('/admin/accounts/' + selected + '/suspend', {
        reason: String(fields.get('reason')),
      });
      document.querySelector('dialog')!.remove();
      inviteLink = '';
      await load();
      flash('Acesso suspenso.');
    }
  });
});
document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  if (button.id === 'theme') {
    document.documentElement.classList.toggle('dark');
    return;
  }
  if (button.id === 'close-dialog') {
    document.querySelector('dialog')?.remove();
    return;
  }
  if (button.dataset.authMode) {
    authMode = button.dataset.authMode;
    feedback = '';
    renderAuth();
    return;
  }
  if (button.dataset.localAccount) {
    (document.querySelector('#email') as HTMLInputElement).value = button.dataset.localAccount;
    (document.querySelector('#password') as HTMLInputElement).value = 'BlackoutLocal!2026';
    return;
  }
  if (button.dataset.account) {
    selected = button.dataset.account;
    inviteLink = '';
    adminBotSetup = null;
    void task(async () => {
      adminBotSetup = (
        await api<{ setup: BotSetup | null }>('/admin/accounts/' + selected + '/bot-setup')
      ).setup;
      adminRuntime = (
        await api<{ runtime: typeof adminRuntime }>('/admin/accounts/' + selected + '/bot-runtime')
      ).runtime;
      adminView();
      document.querySelector('.detail')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return;
  }
  if (['guide-next', 'guide-back', 'guide-edit'].includes(button.id)) {
    guideStep = button.id === 'guide-back' ? 1 : 2;
    merchantView();
    document.querySelector('#guide-content')?.scrollIntoView({ block: 'start' });
    return;
  }
  if (button.id === 'fill-demo-bot' && config?.emulatorHost) {
    (document.querySelector('#bot-token') as HTMLInputElement).value =
      '123456789:' + 'A'.repeat(35);
    (document.querySelector('#telegram-user-id') as HTMLInputElement).value = '987654321';
    return;
  }
  if (button.id === 'toggle-bot-token') {
    const input = document.querySelector<HTMLInputElement>('#bot-token')!;
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
    button.setAttribute('aria-pressed', String(input.type !== 'password'));
    return;
  }
  if (button.id === 'confirm-bot-activation' && adminBotSetup) {
    dialog(
      'Confirmar ativação do bot',
      `<form id="bot-activation-form"><input type="hidden" name="revision" value="${adminBotSetup.revision}"><p>Confirme somente depois de instalar e testar <b>@${esc(adminBotSetup.bot_username)}</b> na Square Cloud. Esta confirmação inicia o período mensal agora.</p><label>ID do aplicativo exclusivo deste cliente<input name="deploymentReference" required minlength="6" maxlength="120" pattern="[A-Za-z0-9_-]{6,120}" autocomplete="off" placeholder="ID da aplicação na Square Cloud"></label><label class="check-label"><input type="checkbox" name="ownerIdConfirmed" required><span>Conferi que o ID ${esc(adminBotSetup.telegram_user_id)} pertence ao responsável pela loja.</span></label><label class="check-label"><input type="checkbox" name="botTested" required><span>Instalei o bot neste aplicativo e testei seu funcionamento no Telegram.</span></label><p class="note">Confirmação manual: este botão registra a ativação; não inicia nem monitora a aplicação da Square Cloud.</p><button type="submit">Confirmar ativação e iniciar mensalidade</button></form>`,
    );
    return;
  }
  if (button.id === 'request-bot-changes' && adminBotSetup) {
    dialog(
      'Solicitar correção dos dados',
      `<form id="bot-changes-form"><input type="hidden" name="revision" value="${adminBotSetup.revision}"><label>O que o cliente precisa corrigir?<input name="note" required minlength="3" maxlength="500" placeholder="Ex.: confira seu ID pessoal do Telegram"></label><small>O motivo aparece no assistente. Não inclua tokens ou outros segredos.</small><button type="submit">Enviar solicitação</button></form>`,
    );
    return;
  }
  if (button.id === 'request-bot-token') {
    dialog(
      'Token para ativação',
      '<p>Este segredo permite controlar o bot. A consulta será registrada no histórico. Use-o somente na configuração privada do servidor na Square Cloud.</p><button id="reveal-bot-token">Consultar token protegido</button>',
    );
    return;
  }
  if (button.id === 'new-account') {
    dialog(
      'Adicionar lojista',
      `<form id="registration-form"><label>Nome do lojista<input name="name" required maxlength="80" autocomplete="name"></label><label>Nome da loja<input name="storeName" required maxlength="80"></label><label>E-mail<input name="email" type="email" required maxlength="254" autocomplete="email"></label><div class="form-row"><label>Canal da contratação<select name="channel"><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="site">Site</option><option value="other">Outro</option></select></label><label>Mensalidade · R$<input name="price" type="number" required min="0.01" max="100000" step="0.01" placeholder="49,90"></label></div><label>Referência da contratação · opcional<input name="reference" maxlength="200" placeholder="Pedido ou conversa conferida"></label><p class="note">O cadastro não confirma pagamento nem inicia a mensalidade.</p><button type="submit">Cadastrar lojista</button></form>`,
    );
    return;
  }
  if (button.id === 'renew-subscription') {
    dialog(
      'Registrar renovação mensal',
      `<form id="renew-form"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><p>Esta ação acrescenta um mês civil ao período atual ou inicia um novo período a partir de hoje, se o anterior venceu.</p><label class="check-row"><input name="paymentConfirmed" type="checkbox" required> Conferi e recebi o pagamento desta renovação pelo canal da contratação.</label><button type="submit">Confirmar renovação</button></form>`,
    );
    return;
  }
  if (button.id === 'suspend') {
    dialog(
      'Suspender acesso',
      '<form id="suspend-form"><label>Motivo<input name="reason" required minlength="3" maxlength="500"></label><p class="note">O lojista continuará podendo entrar para consultar a situação. Os dados serão preservados. Esta ação não desliga o aplicativo na Square Cloud.</p><button type="submit">Confirmar suspensão</button></form>',
    );
    return;
  }
  void task(async () => {
    if (button.id === 'connect-telegram-owner') {
      const link = await api<{ url: string }>('/store/telegram-link', {});
      dialog(
        'Confirme sua conta no Telegram',
        `<p>Abra este link com a conta pessoal do Telegram cujo ID você informou no cadastro e toque em <b>Iniciar</b>. Ele vence em 10 minutos e só pode ser usado uma vez.</p><a class="button-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">Confirmar no meu bot</a><p>Depois, volte ao site e clique em Atualizar situação. A configuração de produtos e estoque será feita pelo comando <code>/admin</code> no bot.</p>`,
      );
    } else if (button.id === 'enroll-admin-mfa') {
      const result = await api<{ secret: string }>('/security/admin-mfa/enroll', {});
      mfaSecret = result.secret;
      await renderAdminMfa();
    } else if (button.id === 'retry-services') {
      await load();
    } else if (button.id === 'start-bot-configuration' && adminBotSetup) {
      await api('/admin/accounts/' + selected + '/bot-setup/review', {
        action: 'configure',
        revision: adminBotSetup.revision,
        note: '',
      });
      await load();
      flash('Configuração iniciada. O cliente já pode acompanhar esse estado.');
    } else if (button.id === 'submit-bot-setup') {
      botSetup = (await api<{ setup: BotSetup }>('/onboarding/submit', {})).setup;
      guideStep = 4;
      merchantView();
      flash('Dados enviados. Aguarde a configuração e ativação pela Blackout Create.');
    } else if (button.id === 'reveal-bot-token') {
      const value = await api<{ token: string }>('/admin/accounts/' + selected + '/bot-token', {});
      dialog(
        'Token para a Square Cloud',
        '<label for="activation-token">Token · ocultado em 30 segundos</label><input id="activation-token" readonly autocomplete="off" spellcheck="false"><small>Transfira somente para a configuração privada da hospedagem. Não envie por mensagem.</small>',
      );
      const input = document.querySelector<HTMLInputElement>('#activation-token')!;
      input.value = value.token;
      value.token = '';
      input.select();
      setTimeout(() => {
        input.value = '';
        input.placeholder = 'Token ocultado. Consulte novamente se necessário.';
      }, 30000);
    } else if (button.id === 'logout') {
      await api('/auth/logout', {});
      await signOut(auth);
      csrf = '';
      me = null;
      adminProof = '';
      mfaSecret = '';
      botSetup = adminBotSetup = null;
      guideStep = 1;
      inviteLink = '';
      feedback = '';
      authMode = 'login';
      authEmail = '';
      history.replaceState(null, '', location.pathname + '#/entrar');
      renderAuth();
    } else if (button.id === 'verified') await exchange();
    else if (button.id === 'resend') {
      if (!auth.currentUser)
        throw new ApiError('LOGIN_REQUIRED', 'Entre novamente para reenviar a confirmação.', 401);
      await sendEmailVerification(auth.currentUser, { url: location.origin });
      flash('Confirmação reenviada. Confira seu e-mail.');
    } else if (button.id === 'accept-invite') {
      await api('/invitations/accept', { token: inviteToken() });
      history.replaceState(null, '', location.pathname + '#/conta');
      await load();
      flash('Loja vinculada. Aguarde a aprovação da Blackout Create.');
    } else if (button.id === 'confirm-purchase') {
      await api('/admin/accounts/' + selected + '/confirm-purchase', {});
      await load();
      flash('Contratação confirmada. Você já pode gerar o convite.');
    } else if (button.id === 'issue-invite') {
      const value = await api<{ url: string }>('/admin/accounts/' + selected + '/invitations', {});
      inviteLink = value.url;
      adminView();
      flash('Convite gerado. Copie e envie ao lojista.');
    } else if (button.id === 'approve') {
      await api('/admin/accounts/' + selected + '/approve', {});
      await load();
      flash('Acesso liberado. A mensalidade ainda não começou.');
    } else if (button.id === 'restore') {
      await api('/admin/accounts/' + selected + '/restore', {});
      await load();
      flash('Suspensão removida.');
    } else if (button.id === 'copy-invite') {
      try {
        await navigator.clipboard.writeText(inviteLink);
        flash('Convite copiado.');
      } catch {
        (document.querySelector('#invite-link') as HTMLInputElement).select();
        flash('Selecione e copie o link exibido.');
      }
    } else if (button.id === 'refresh') await load();
    else if (button.dataset.section) {
      section = button.dataset.section;
      offset = 0;
      selected = null;
      inviteLink = '';
      await load();
    } else if (button.id === 'next' || button.id === 'previous') {
      offset += button.id === 'next' ? 50 : -50;
      selected = null;
      await load();
    }
  });
});
window.addEventListener('hashchange', () => void task(load));
await task(load);
