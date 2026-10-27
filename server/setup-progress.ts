import type { DocumentStore, DocumentTransaction } from './document-store.js';
import { botTransaction } from './bot-data.js';
import type { Product, Shop } from './bot-types.js';
import { hasSupport } from './bot-appearance.js';
import { HttpError } from './types.js';

export type SetupCheck = { id: string; title: string; done: boolean; href: string };
export type SetupStep = {
  id: string;
  title: string;
  detail: string;
  state: 'done' | 'current' | 'locked';
  action: { label: string; href?: string; command?: 'owner' | 'refresh' } | null;
};
export type SetupProgress = {
  completed: number;
  total: number;
  ready: boolean;
  message: string;
  steps: SetupStep[];
  checks: SetupCheck[];
};

// Derived from durable domain records. No client-side checkbox can grant readiness,
// activate a bot or start a subscription. Reads never create progress or change billing.
export async function setupProgress(
  tx: DocumentTransaction,
  id: string,
  uid: string,
  now = new Date(),
): Promise<SetupProgress> {
  const [account, setup, runtime, value] = await Promise.all([
    tx.get('merchant_accounts/' + id),
    tx.get('merchant_bot_setup/' + id),
    tx.get('bot_runtimes/' + id),
    tx.get('bot_shops/' + id),
  ]);
  if (!account || account.firebase_uid !== uid)
    throw new HttpError(
      403,
      'STORE_OWNER_REQUIRED',
      'Acompanhamento indisponível para esta conta.',
    );
  const shop = value as Shop | null;
  const paid = Boolean(account.purchase_confirmed_at),
    approved = account.access_status === 'approved';
  const connected = Boolean(
    setup?.submitted_at &&
      runtime &&
      !runtime.revoked &&
      runtime.bot_id === setup.bot_id &&
      ['configuring', 'active'].includes(setup.activation_status),
  );
  const owner = Boolean(
    connected && shop?.owner_id === setup?.telegram_user_id && shop?.owner_bot_id === setup?.bot_id,
  );
  const online = Boolean(
    connected &&
      runtime?.last_seen instanceof Date &&
      now.getTime() - runtime.last_seen.getTime() < 90000,
  );
  const active =
    setup?.activation_status === 'active' &&
    account.paid_through instanceof Date &&
    account.paid_through > now;
  let payment = false;
  if (shop) {
    if (shop.payment_mode === 'stars') payment = true;
    else if ((shop.pix_mode ?? 'manual') === 'manual')
      payment = Boolean(shop.payment_instructions?.trim() || shop.pix_keys?.length);
    else if (shop.pix_mode === 'mercadopago' && shop.mp_connection)
      payment = Boolean(
        await tx.get(`merchant_payment_secrets/${id}/connections/${shop.mp_connection}`),
      );
    else if (shop.pix_mode === 'purincash' && shop.purin_connection && shop.purin_subaccount) {
      const [platform, connection, claim] = await Promise.all([
        tx.get('platform_payments/purincash'),
        tx.get('platform_payments/purincash/connections/' + shop.purin_connection),
        tx.get('purin_subaccount_claims/' + shop.purin_subaccount),
      ]);
      payment = Boolean(
        platform?.generation === shop.purin_connection && connection && claim?.account_id === id,
      );
    }
  }
  const products = (shop?.products ?? []) as Product[];
  const checks: SetupCheck[] = [
    {
      id: 'welcome',
      title: 'Mensagem de entrada',
      done: Boolean(shop?.welcome?.trim()),
      href: '#/gestao?section=appearance',
    },
    {
      id: 'catalog',
      title: 'Produto disponível com estoque',
      done: products.some((p) => p.enabled && p.price > 0 && p.stock > 0),
      href: '#/gestao?section=' + (products.some((p) => p.enabled) ? 'stock' : 'products'),
    },
    {
      id: 'support',
      title: 'Canal de atendimento',
      done: Boolean(shop && hasSupport(shop)),
      href: '#/gestao?section=support',
    },
    {
      id: 'payment',
      title: 'Forma de pagamento configurada',
      done: payment,
      href: '#/gestao?section=payments',
    },
  ];
  const configured = Boolean(connected && checks.every((check) => check.done));
  const ready = Boolean(paid && approved && connected && owner && configured && online && active);
  const complete = [paid, connected, owner, configured, ready];
  const current = complete.findIndex((done) => !done);
  const canManage = paid && approved && connected;
  const nextCheck = checks.find((check) => !check.done);
  const username =
    typeof setup?.bot_username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(setup.bot_username)
      ? setup.bot_username
      : null;
  const steps: SetupStep[] = [
    {
      id: 'payment',
      title: 'Pagamento confirmado',
      detail: paid
        ? 'Sua contratação está registrada nesta conta.'
        : 'Conclua o pagamento do plano para liberar sua loja.',
      state: 'locked',
      action: {
        label: paid ? 'Ver contratação' : 'Continuar compra',
        href: paid ? '#/configuracao?contract=1' : '#/comprar',
      },
    },
    {
      id: 'bot',
      title: 'Conectar bot',
      detail: connected
        ? 'O aplicativo está vinculado ao bot da sua loja.'
        : setup?.submitted_at
          ? 'Dados recebidos. A hospedagem ainda precisa conectar o bot.'
          : 'Crie seu bot no BotFather e envie o token pelo formulário protegido.',
      state: 'locked',
      action:
        paid && approved
          ? {
              label: connected
                ? 'Ver conexão'
                : setup?.submitted_at
                  ? 'Acompanhar conexão'
                  : 'Conectar meu bot',
              href: '#/configuracao?step=bot',
            }
          : null,
    },
    {
      id: 'owner',
      title: 'Confirmar responsável',
      detail: owner
        ? 'Sua conta pessoal foi confirmada no Telegram.'
        : 'Abra o link de confirmação com a conta do ID informado e toque em Iniciar.',
      state: 'locked',
      action: canManage
        ? owner
          ? { label: 'Ver confirmação', href: '#/configuracao' }
          : { label: 'Confirmar no Telegram', command: 'owner' }
        : null,
    },
    {
      id: 'store',
      title: 'Configurar loja',
      detail: `${checks.filter((check) => check.done).length} de ${checks.length} requisitos salvos. Banner é opcional.`,
      state: 'locked',
      action: canManage
        ? {
            label: configured ? 'Revisar minha loja' : 'Continuar configuração',
            href: nextCheck?.href ?? '#/gestao?section=overview',
          }
        : null,
    },
    {
      id: 'ready',
      title: 'Loja pronta',
      detail: ready
        ? 'Configuração concluída e bot conectado. Confira a experiência do comprador no Telegram.'
        : !approved
          ? 'Seu acesso precisa estar liberado para concluir.'
          : !configured || !owner
            ? 'Conclua as etapas anteriores para preparar sua loja.'
            : !active
              ? 'Aguardando ativação ou renovação da assinatura.'
              : 'Aguardando o bot conectar novamente.',
      state: 'locked',
      action:
        ready && username
          ? { label: 'Abrir minha loja no Telegram', href: 'https://t.me/' + username }
          : configured && owner && approved
            ? active
              ? { label: 'Verificar conexão', command: 'refresh' }
              : {
                  label: 'Ver ativação e assinatura',
                  href: account.billing_started_at
                    ? '#/minha-loja?subscription=1'
                    : '#/configuracao',
                }
            : null,
    },
  ];
  for (let index = 0; index < steps.length; index++)
    steps[index].state = complete[index] ? 'done' : index === current ? 'current' : 'locked';
  if (!approved) for (const step of steps) step.action = null;
  return {
    completed: complete.filter(Boolean).length,
    total: 5,
    ready,
    steps,
    checks,
    message: !approved
      ? account.access_status === 'suspended'
        ? 'Acesso suspenso. Fale com a Blackout para continuar.'
        : 'Aguardando liberação do acesso.'
      : ready
        ? 'Sua loja está pronta para receber compradores.'
        : 'Continue de onde parou. O acompanhamento usa os dados salvos da sua loja.',
  };
}
export function readSetupProgress(store: DocumentStore, id: string, uid: string) {
  return botTransaction(store, (tx) => setupProgress(tx, id, uid));
}
