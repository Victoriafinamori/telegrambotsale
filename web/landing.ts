import { themeControl } from './theme.js';
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function publicContactUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
const icon = (name: string) => {
  const paths: Record<string, string> = {
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11"/>',
    pix: '<path d="m12 3 9 9-9 9-9-9 9-9Zm-5 5 5 5 5-5M7 16l5-5 5 5"/>',
    box: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
    wallet: '<path d="M4 8V5h15v3M3 8h18v13H3V8Zm13 4h5v5h-5v-5Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    notice: '<path d="m4 10 15-6v16L4 14v-4ZM4 10H2v4h2m3 1 2 6h4l-2-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
};
const demo = 'https://t.me/blackoutshopbrbot';
const faqs = [
  [
    'Onde vou configurar minha loja?',
    'No menu administrativo do seu bot no Telegram: produtos, categorias, estoque, pedidos, aparência, suporte, pagamentos, cupons, avisos e carteira. No site, você contrata, renova e conecta seu bot com segurança.',
  ],
  [
    'O bot aceita Pix automático?',
    'Sim. O Pix integrado Blackout usa a PurinCash para gerar o QR Code e o copia e cola. Depois da confirmação do pagamento, o sistema libera a entrega do produto digital conforme o estoque cadastrado. A modalidade precisa estar habilitada para a loja e segue as taxas e condições do provedor. Também há Pix manual com análise de comprovante pelo lojista.',
  ],
  [
    'Como funciona a entrega de produtos digitais?',
    'O lojista cadastra os arquivos ou códigos no estoque. Após a confirmação do pagamento, o bot entrega o conteúdo ao comprador pelo Telegram. O cliente pode acompanhar os pedidos e consultar seu histórico na conversa.',
  ],
  [
    'Consigo personalizar a loja?',
    'Sim. Você pode editar a mensagem e o banner de entrada, criar categorias com seus próprios emojis, cadastrar produtos com imagens opcionais, alterar preços e configurar nome, telefone e link de suporte. O nome e a identidade do bot são definidos no BotFather.',
  ],
  [
    'Como funciona a carteira e o saque?',
    'As vendas com Pix integrado Blackout são atribuídas à carteira da loja. O lojista consulta saldo disponível, bloqueios e histórico pelo Telegram, e solicita o saque por Pix. A operação pede conferência e confirmação no canal escolhido, e está sujeita às taxas, limites e liberações do provedor.',
  ],
  [
    'Preciso criar meu próprio bot?',
    'Sim. Você cria seu bot no BotFather. Após o Pix da contratação ser confirmado, seu painel é liberado para seguir a configuração protegida. A Blackout acompanha a preparação e a ativação. O período contratado começa após a confirmação da ativação pela equipe.',
  ],
];
export function landingPage(contact: string | null, signedIn = false) {
  const cta = '<a class="lp-button" href="#/comprar">Quero meu bot ' + icon('arrow') + '</a>';
  const check = (text: string) => '<li>' + icon('check') + '<span>' + text + '</span></li>';
  return `<div class="landing-page">
  <a class="lp-skip" href="#conteudo">Pular para o conteúdo</a>
  <header class="lp-header lp-container"><a class="brand" href="/" aria-label="Blackout Create, início"><img src="/brand.webp" alt="" width="42" height="42"><span>Blackout <small>Create</small></span></a><nav class="lp-nav" aria-label="Navegação principal"><a href="#experiencia">Recursos</a><a href="#pagamentos">Pix integrado</a><a href="#como-funciona">Como funciona</a></nav><div class="lp-header-actions">${themeControl()}<a class="lp-login" id="landing-login" href="#/entrar">${signedIn ? 'Minha conta' : 'Entrar'} ${icon('arrow')}</a></div></header>
  <main id="conteudo">
    <section class="lp-hero lp-container" aria-labelledby="lp-title">
      <div class="lp-hero-copy"><h1 id="lp-title">Uma loja completa.<br><span>Dentro do Telegram.</span></h1><p>Seu catálogo, seus clientes, sua marca. Venda produtos digitais com Pix integrado e entrega automática, sem sair da conversa.</p><div class="lp-actions">${cta}<a class="lp-text-link" href="${demo}" target="_blank" rel="noopener noreferrer">Conhecer a loja real ${icon('arrow')}</a></div><div class="lp-hero-note">${icon('check')} Contrate pelo site. Gerencie pelo seu bot.</div></div>
      <figure class="lp-product"><div class="lp-product-top"><span class="lp-product-dot"></span><span>BLACKOUT NO TELEGRAM</span><a href="${demo}" target="_blank" rel="noopener noreferrer" aria-label="Abrir demonstração">${icon('arrow')}</a></div><div class="lp-product-screen"><img src="/examples/bot-start-cliente.png" width="363" height="673" alt="Tela real de início do bot Blackout: catálogo, carrinho, pedidos e suporte" fetchpriority="high"></div><figcaption>Uma conversa. A experiência de uma loja.</figcaption></figure>
    </section>
    <div class="lp-feature-strip"><ul class="lp-container"><li>${icon('pix')} Pix automático</li><li>${icon('box')} Entrega digital</li><li>${icon('wallet')} Carteira integrada</li><li>${icon('phone')} Gestão no Telegram</li></ul></div>
    <section class="lp-section lp-container lp-control" id="experiencia" aria-labelledby="lp-control-title"><div class="lp-section-heading"><h2 id="lp-control-title">Sua operação.<br>Em uma conversa.</h2><p>Do primeiro produto ao próximo pedido, o menu administrativo do seu bot coloca o controle nas suas mãos.</p><a class="lp-text-link" href="${demo}" target="_blank" rel="noopener noreferrer">Explorar a demonstração ${icon('arrow')}</a></div><div class="lp-control-list"><article><span>${icon('box')}</span><div><h3>Um catálogo com a sua cara</h3><p>Organize categorias, escolha emojis e personalize produtos com descrição, preço e banner opcional.</p></div></article><article><span>${icon('panel')}</span><div><h3>Estoque pronto para entregar</h3><p>Cadastre seu conteúdo digital e acompanhe a disponibilidade. Após o pagamento confirmado, o bot faz a entrega conforme o estoque.</p></div></article><article><span>${icon('notice')}</span><div><h3>O cliente continua por perto</h3><p>Histórico de pedidos, suporte, avisos e notificações de reposição na conversa que ele já conhece.</p></div></article></div></section>
    <section class="lp-payment-section" id="pagamentos"><div class="lp-container lp-payment-layout"><div class="lp-payment-demo" aria-label="Como funciona o Pix integrado"><div class="lp-payment-symbol">${icon('pix')}</div><h3>Escolheu. Pagou. Recebeu.</h3><ol><li><span>1</span><div><b>O cliente escolhe</b><p>Compra direta ou carrinho no Telegram.</p></div></li><li><span>2</span><div><b>O Pix é confirmado</b><p>QR Code e copia e cola para o pedido.</p></div></li><li><span>3</span><div><b>O bot entrega</b><p>Conteúdo enviado após a confirmação.</p></div></li></ol><div class="lp-provider">Pagamento integrado com <b>PurinCash</b></div></div><div class="lp-section-heading"><h2>O Pix cai.<br>A loja segue.</h2><p>Menos etapas entre a compra e a entrega. Com o Pix integrado Blackout, o pagamento confirmado atualiza o pedido automaticamente.</p><ul class="lp-checks">${check('QR Code e Pix copia e cola no Telegram')}${check('Entrega automática de produtos digitais')}${check('Saldo, histórico e saque na carteira do bot')}</ul><p class="lp-fineprint">Disponível após a ativação do Pix integrado. Taxas, limites e liberações seguem as condições da loja e da PurinCash. Pix manual também disponível.</p></div></div></section>
    <section class="lp-section lp-container lp-start" id="como-funciona"><div class="lp-section-heading"><h2>Da ideia à loja.<br>Um passo de cada vez.</h2><p>O site prepara sua conexão. O Telegram vira seu lugar de trabalho.</p></div><ol class="lp-steps"><li><span>01</span><h3>Escolha seu plano</h3><p>Contrate por Pix e crie seu acesso após o pagamento. Mensal, trimestral ou anual: escolha o período no checkout.</p></li><li><span>02</span><h3>Conecte seu bot</h3><p>Crie seu bot no BotFather e informe o token e seu ID no formulário protegido. Confirme sua conta no Telegram.</p></li><li><span>03</span><h3>Deixe com a sua cara</h3><p>No menu do bot, configure a loja, adicione os produtos e prepare seu estoque. Depois, compartilhe com seus clientes.</p></li></ol></section>
    <section class="lp-section lp-container lp-faq" id="duvidas"><div class="lp-section-heading"><h2>Antes de começar.</h2><p>As respostas para tirar sua loja do papel.</p><a class="lp-text-link" href="${esc(contact || demo)}" target="_blank" rel="noopener noreferrer">Ainda tem uma dúvida? ${icon('arrow')}</a></div><div>${faqs.map(([q, a]) => '<details><summary>' + q + icon('plus') + '</summary><p>' + a + '</p></details>').join('')}</div></section>
    <section class="lp-container lp-contact" id="contratar"><div><h2>Sua marca.<br>Seu bot. Vamos começar?</h2><p>Leve seus produtos para onde seus clientes já estão.</p></div>${cta}</section>
  </main><footer class="lp-footer lp-container"><a class="brand" href="/" aria-label="Blackout Create, início"><img src="/brand.webp" alt="" width="36" height="36"><span>Blackout <small>Create</small></span></a><p>Produtos digitais. Relações reais.</p><a href="#/entrar">Acessar minha conta ${icon('arrow')}</a></footer></div>`;
}
