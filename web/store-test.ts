import type { StoreTest, TestMessage } from '../server/store-test.js';
import './store-test.css';
type Session = Awaited<ReturnType<StoreTest['start']>>;
type Api = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (value: number, currency = 'BRL') =>
  currency === 'BRL'
    ? (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : value + ' Stars';
const labels: Record<string, string> = {
  awaiting_payment: 'Aguardando pagamento fictício',
  precheckout: 'Pagamento fictício em processamento',
  awaiting_review: 'Comprovante fictício aguardando aprovação',
  paid: 'Entrega de teste pendente',
  delivered: 'Entrega de teste concluída',
  cancelled: 'Pedido de teste cancelado',
  rejected: 'Pagamento fictício recusado',
  expired: 'Pedido de teste vencido',
};
export async function mountStoreTest(
  host: HTMLElement,
  api: Api,
  privateFile: (path: string) => Promise<Blob>,
) {
  let session: Session | null = null,
    busy = false,
    error = '';
  const urls = new Set<string>();
  const assets = new Map<string, Promise<string>>();
  const revoke = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    assets.clear();
  };
  const lifecycle = new AbortController();
  const cleanup = () => {
    revoke();
    lifecycle.abort();
    observer.disconnect();
  };
  const observer = new MutationObserver(() => {
    if (!host.isConnected) cleanup();
  });
  observer.observe(host.closest('#merchant-console-host') ?? host.parentElement!, {
    childList: true,
    subtree: true,
  });
  window.addEventListener(
    'hashchange',
    () => {
      cleanup();
    },
    { once: true, signal: lifecycle.signal },
  );
  const message = (m: TestMessage) =>
    `<article class="st-message ${m.delivery ? 'st-delivery' : ''}"><span class="st-message-label">${m.delivery ? 'Entrega fictícia' : m.kind === 'invoice' ? 'Fatura fictícia' : m.kind === 'file' ? 'Arquivo fictício' : 'Mensagem do bot'}</span>${m.asset ? `<div class="st-photo" data-test-asset="${esc(m.asset)}">Carregando imagem salva…</div>` : m.kind === 'photo' ? '<p class="st-file">Comprovante fictício</p>' : ''}<p>${esc(m.text)}</p>${m.delivery && m.kind === 'file' ? '<button class="quiet" data-test-download>Baixar arquivo de exemplo</button>' : ''}${m.buttons.length ? `<div class="st-buttons">${m.buttons.map((b) => `<button class="quiet" data-test-callback="${esc(b.data)}" data-test-message="${m.id}" ${busy ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}</div>` : ''}</article>`;
  const render = () => {
    if (!host.isConnected) return;
    const pending = session?.orders.find((order) =>
      ['awaiting_payment', 'precheckout', 'awaiting_review'].includes(order.status),
    );
    host.innerHTML = `<section class="mc-panel st-intro"><h2>Teste sua loja sem fazer uma venda</h2><p>Converse com uma cópia do bot, crie um pedido e simule o pagamento. Nenhuma cobrança é gerada, nenhuma mensagem é enviada pelo Telegram e o estoque real permanece intacto.</p><p class="mc-note">O teste usa a mesma lógica de catálogo, carrinho, pedidos e entrega. Os códigos e arquivos são fictícios. A conexão com os provedores e a entrega pelo Telegram precisam ser validadas separadamente.</p>${!session ? '<form data-test-start><label>Entrega que deseja experimentar<select name="deliveryKind"><option value="code">Código digital fictício</option><option value="file">Arquivo de exemplo</option></select></label><button type="submit">Iniciar simulação</button></form>' : `<div class="st-session-info"><span class="badge">Modo de teste</span><span>Cópia salva em ${new Date(session.createdAt).toLocaleString('pt-BR')} · ${session.actionsLeft} ações restantes</span></div><p class="mc-note">O teste fica salvo por até 2 horas. A cópia inclui até 10 unidades por produto. Produtos esgotados continuam esgotados; você pode repor unidades fictícias abaixo. Alterações feitas na loja depois do início só entram em um novo teste.</p><details><summary>Reiniciar com os dados atuais da loja</summary><p>Isso substitui apenas esta simulação. O histórico e os produtos reais não são alterados.</p><form data-test-start><label>Tipo de entrega<select name="deliveryKind"><option value="code">Código digital fictício</option><option value="file">Arquivo de exemplo</option></select></label><button type="submit" class="quiet">Iniciar novo teste</button></form></details><button class="quiet" data-test-resume>Retomar teste salvo</button>`}</section>${
      session
        ? `<div class="st-layout"><section class="mc-panel"><h2>Visão do comprador</h2><p class="mc-note">Prévia aproximada das mensagens. Os botões abaixo operam somente nesta simulação.</p><div class="st-chat" role="region" tabindex="0" aria-label="Conversa de teste do comprador">${session.messages
            .filter((m) => m.audience === 'buyer')
            .map(message)
            .join(
              '',
            )}</div><form class="st-text-form" data-test-text><label>Comando ou cupom<input name="text" maxlength="200" required placeholder="/start, /pedidos, /suporte ou cupom" autocomplete="off"></label><button type="submit">Enviar no teste</button></form></section><aside class="st-controls"><section class="mc-panel"><h2>Pagamento fictício</h2><p>Modo da loja: <b>${esc({ manual: 'Pix manual', purincash: 'Pix integrado Blackout', mercadopago: 'Mercado Pago', stars: 'Telegram Stars' }[session.mode] ?? session.mode)}</b>.</p>${session.mode !== 'manual' && session.mode !== 'stars' ? '<p class="mc-note">Neste teste, a aprovação é reproduzida localmente. Não há consulta, QR Code, webhook ou cobrança real do provedor.</p>' : ''}<div class="st-payment-actions">${pending ? `<p>Pedido de teste ${esc(pending.id)}</p>${session.mode !== 'stars' ? '<button class="quiet" data-test-command="receipt">Simular envio de comprovante</button>' : ''}<button data-test-command="approve">Simular pagamento aprovado</button>${session.mode !== 'stars' ? '<button class="quiet" data-test-command="reject">Simular pagamento recusado</button>' : ''}` : '<p>Escolha um produto e gere um pedido na conversa de teste para liberar estes controles.</p>'}</div></section><section class="mc-panel"><h2>Pedidos desta simulação</h2>${session.orders.length ? session.orders.map((order) => `<article class="st-order"><b>Teste ${esc(order.id)}</b><p>${esc(labels[order.status] ?? order.status)}</p><p>${order.items.map((item) => `${item.quantity} × ${esc(item.title)}`).join('<br>')}</p><strong>${money(order.total, order.currency)}</strong></article>`).join('') : '<p>Nenhum pedido de teste criado.</p>'}</section><section class="mc-panel"><h2>Estoque fictício</h2>${session.products.length ? session.products.map((p) => `<div class="st-stock"><span>${esc(p.title)}<small>${p.stock} unidades de teste${p.enabled ? '' : ' · produto oculto'}</small></span><button class="quiet" data-test-stock="${esc(p.id)}" ${p.stock >= 10 ? 'disabled' : ''}>Repor 1</button></div>`).join('') : '<p>Cadastre categorias e produtos na loja e inicie um novo teste.</p>'}</section>${
            session.messages.some((m) => m.audience === 'owner')
              ? `<section class="mc-panel"><h2>Visão do lojista</h2><div class="st-chat" aria-label="Conversa de teste do lojista">${session.messages
                  .filter((m) => m.audience === 'owner')
                  .map(message)
                  .join('')}</div></section>`
              : ''
          }</aside></div>`
        : ''
    }<p class="st-feedback" role="status" ${error ? '' : 'hidden'}>${esc(error)}</p>`;
    host.setAttribute('aria-busy', String(busy));
    host.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      if (busy) button.disabled = true;
    });
    void Promise.all(
      Array.from(host.querySelectorAll<HTMLElement>('[data-test-asset]'), async (el) => {
        try {
          const asset = el.dataset.testAsset!;
          let pending = assets.get(asset);
          if (!pending) {
            pending = privateFile('/store/manage/media/' + encodeURIComponent(asset)).then(
              (blob) => {
                if (lifecycle.signal.aborted) throw Error('Preview closed');
                const url = URL.createObjectURL(blob);
                urls.add(url);
                return url;
              },
            );
            assets.set(asset, pending);
          }
          const url = await pending;
          if (!el.isConnected) return;
          const image = new Image();
          image.src = url;
          image.alt = 'Banner salvo na loja';
          el.replaceChildren(image);
        } catch {
          if (el.isConnected) el.textContent = 'Banner configurado na loja';
        }
      }),
    );
    if (error)
      host.querySelector<HTMLElement>('.st-feedback')?.scrollIntoView({ block: 'nearest' });
  };
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    error = '';
    host.setAttribute('aria-busy', 'true');
    const buttons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button'),
      (button) => [button, button.disabled] as const,
    );
    buttons.forEach(([button]) => {
      button.disabled = true;
    });
    try {
      await operation();
    } catch (e) {
      error =
        e instanceof Error
          ? e.message
          : 'Não foi possível continuar a simulação. Use Retomar teste salvo antes de tentar novamente.';
    } finally {
      busy = false;
      render();
      buttons.forEach(([button, disabled]) => {
        if (button.isConnected) button.disabled = disabled;
      });
    }
  };
  const action = (command: string, value = '', messageId?: number) => {
    if (!session) return;
    void run(async () => {
      session = await api<Session>('/store/manage/test/action', {
        sessionId: session!.id,
        revision: session!.revision,
        requestId: crypto.randomUUID(),
        action: command,
        value,
        ...(messageId ? { messageId } : {}),
      });
    });
  };
  host.addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement;
      if (!form.matches('[data-test-start], [data-test-text]')) return;
      event.preventDefault();
      event.stopPropagation();
      const fields = new FormData(form);
      if (form.matches('[data-test-start]'))
        void run(async () => {
          session = await api<Session>('/store/manage/test/start', {
            deliveryKind: fields.get('deliveryKind'),
            requestId: crypto.randomUUID(),
          });
        });
      else action('text', String(fields.get('text')));
    },
    { signal: lifecycle.signal },
  );
  host.addEventListener(
    'click',
    (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || busy) return;
      event.stopPropagation();
      if (button.dataset.testCallback)
        action('button', button.dataset.testCallback, Number(button.dataset.testMessage));
      if (button.dataset.testCommand) action(button.dataset.testCommand);
      if (button.dataset.testStock) action('restock', button.dataset.testStock);
      if (button.hasAttribute('data-test-resume'))
        void run(async () => {
          session = (await api<{ session: Session | null }>('/store/manage/test')).session;
        });
      if (button.hasAttribute('data-test-download')) {
        const url = URL.createObjectURL(
          new Blob(
            [
              'BLACKOUT CREATE — ARQUIVO DE TESTE\nEntrega fictícia. Nenhum produto real foi consumido.\n',
            ],
            { type: 'text/plain;charset=utf-8' },
          ),
        );
        urls.add(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'blackout-entrega-de-teste.txt';
        link.click();
      }
    },
    { signal: lifecycle.signal },
  );
  host.innerHTML = '<p role="status">Carregando o modo de teste…</p>';
  try {
    session = (await api<{ session: Session | null }>('/store/manage/test')).session;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Não foi possível abrir o modo de teste.';
  }
  render();
}
