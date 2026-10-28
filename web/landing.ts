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
    'No painel web da Blackout: produtos, categorias, estoque, pedidos, aparência, suporte, pagamentos, cupons, avisos e carteira. A gestão do dia a dia pode ser feita pelo site. O Telegram continua disponível para os clientes e para as ações que pedem confirmação do lojista.',
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
    'As vendas com Pix integrado Blackout são atribuídas à carteira da loja. O lojista consulta saldo disponível, bloqueios e histórico pelo site ou Telegram, e solicita o saque por Pix. A operação pede conferência e confirmação no canal escolhido, e está sujeita às taxas, limites e liberações do provedor.',
  ],
  [
    'Preciso criar meu próprio bot?',
    'Sim. Você cria seu bot no BotFather. Após o Pix da contratação ser confirmado, seu painel é liberado para seguir a configuração protegida. A Blackout acompanha a preparação e a ativação. O período contratado começa após a confirmação da ativação pela equipe.',
  ],
];
export function landingPage(contact: string | null, signedIn = false) {
  const cta = `<a class="lp-button" href="#/comprar">Quero meu bot ${icon('arrow')}</a>`;
  const check = (text: string) => `<li>${icon('check')}<span>${text}</span></li>`;
  return `<div class="landing-page">
    <a class="lp-skip" href="#conteudo">Pular para o conteúdo</a>
    <header class="lp-header lp-container"><a class="brand" href="/" aria-label="Blackout Create, início"><img src="/brand.webp" alt="" width="44" height="44"><span>Blackout <small>Create</small></span></a><nav class="lp-nav" aria-label="Navegação principal"><a href="#experiencia">O painel</a><a href="#pagamentos">Pagamentos</a><a href="#como-funciona">Como começar</a><a href="#duvidas">Dúvidas</a></nav>${themeControl()}<a class="lp-login" id="landing-login" href="#/entrar">${signedIn ? 'Minha área' : 'Entrar'} ${icon('arrow')}</a></header>
    <main id="conteudo">
      <section class="lp-hero lp-container" aria-labelledby="lp-title"><div class="lp-hero-top"><h1 id="lp-title">Sua loja no Telegram.<br><span>Seu controle, no site.</span></h1><div class="lp-hero-copy"><p>Um bot de vendas para produtos digitais, com Pix automático, entrega integrada e um painel para cuidar da operação.</p><div class="lp-actions">${cta}<a class="lp-text-link" href="${demo}" target="_blank" rel="noopener noreferrer">Ver o bot funcionando ${icon('arrow')}</a></div></div></div>
      <figure class="lp-dashboard-proof"><div class="lp-proof-bar"><span>${icon('panel')} Painel Blackout</span><span>Captura real · loja de demonstração</span></div><div class="lp-dashboard-image"><img class="lp-preview-light" src="/examples/painel-blackout.jpg" alt="Painel real da Blackout Create com produtos, estoque, pedidos, carteira e personalização no menu lateral" width="2028" height="1159" fetchpriority="high"><img class="lp-preview-dark" src="/examples/painel-blackout-dark.jpg" alt="Painel real da Blackout Create em tema escuro" width="2028" height="1159"></div><figcaption>Este é o painel que você usa. As alterações salvas aqui também entram no seu bot.</figcaption></figure>
      <ul class="lp-capabilities"><li>${icon('pix')} Pix automático integrado</li><li>${icon('box')} Estoque e entrega digital</li><li>${icon('wallet')} Carteira e saques por Pix</li><li>${icon('phone')} Gestão pelo site ou Telegram</li></ul></section>
      <section class="lp-section lp-container lp-control" id="experiencia" aria-labelledby="lp-control-title"><div class="lp-section-heading"><h2 id="lp-control-title">A loja é sua.<br>O painel também.</h2><p>Chega de procurar um comando para cada ajuste. Organize a operação em um só lugar, pelo computador ou celular.</p></div><div class="lp-control-list"><article><span>${icon('box')}</span><div><h3>Do produto ao estoque</h3><p>Crie categorias, escolha emojis, adicione fotos, ajuste preços e mude a ordem dos produtos. Cadastre os arquivos e códigos que o bot vai entregar.</p></div></article><article><span>${icon('panel')}</span><div><h3>Uma vitrine com a sua identidade</h3><p>Personalize a entrada da loja, os banners dos produtos e os dados de suporte. Confira a prévia antes de salvar.</p></div></article><article><span>${icon('notice')}</span><div><h3>Pedidos, clientes e relacionamento</h3><p>Acompanhe vendas e pedidos, revise comprovantes do Pix manual, crie cupons e prepare avisos para os clientes inscritos.</p></div></article></div></section>
      <section class="lp-payments" id="pagamentos" aria-labelledby="lp-payment-title"><div class="lp-container lp-payment-layout"><div class="lp-section-heading"><h2 id="lp-payment-title">O Pix confirma.<br>A entrega continua.</h2><p>No Pix integrado Blackout, a PurinCash processa o pagamento e a confirmação alimenta o pedido. O bot entrega o produto digital após a confirmação, conforme o estoque.</p><ul class="lp-checks">${check('QR Code e Pix copia e cola por pedido')}${check('Confirmação automática do pagamento')}${check('Saldo atribuído à carteira da loja')}${check('Histórico e solicitação de saque por Pix')}</ul><p class="lp-fineprint">Requer ativação do Pix integrado. Taxas, limites e liberações seguem as condições da conta e do provedor. Pix manual com comprovante também disponível.</p></div><div class="lp-payment-route" aria-label="Etapas do pagamento integrado"><div>${icon('box')}<span>Seu cliente escolhe o produto</span></div><span class="lp-route-line" aria-hidden="true"></span><div>${icon('pix')}<span>Paga o Pix do pedido</span></div><span class="lp-route-line" aria-hidden="true"></span><div>${icon('check')}<span>A confirmação libera a entrega</span></div><span class="lp-route-line" aria-hidden="true"></span><div>${icon('wallet')}<span>Você acompanha na carteira</span></div><p>Integrado à <b>PurinCash</b><br><small>Pagamento do pedido e saldo da loja conectados.</small></p></div></div></section>
      <section class="lp-section lp-container lp-bot-section" aria-labelledby="lp-bot-title"><figure class="lp-bot-proof"><div class="lp-bot-image"><img src="/examples/bot-start-cliente.png" width="363" height="673" loading="lazy" decoding="async" alt="Tela inicial real do bot Blackout na visão do comprador, com banner, boas-vindas, Produtos, Carrinho, Meus pedidos e Suporte"></div><figcaption>Tela inicial /start da Blackout no Telegram.<br>É assim que o comprador encontra a sua loja.</figcaption></figure><div class="lp-section-heading"><h2 id="lp-bot-title">Do outro lado,<br>é só conversar.</h2><p>Seu cliente encontra as categorias, vê os detalhes do produto e escolhe entre comprar direto ou adicionar ao carrinho.</p><ul class="lp-checks">${check('Produtos com banner opcional e descrição')}${check('Carrinho e compra direta')}${check('Meus pedidos e histórico de compras')}${check('Aviso de reposição para produtos sem estoque')}${check('Suporte da sua loja na própria conversa')}</ul><a class="lp-button lp-button-outline" href="${demo}" target="_blank" rel="noopener noreferrer">Abrir a loja de demonstração ${icon('arrow')}</a><p class="lp-fineprint">Você pode conhecer o catálogo sem concluir uma compra.</p></div></section>
      <section class="lp-section lp-container lp-start" id="como-funciona" aria-labelledby="lp-start-title"><div class="lp-section-heading"><h2 id="lp-start-title">Seu bot. Sua marca.<br>Vamos colocar para vender.</h2><p>A configuração inicial tem orientação. Depois, a gestão da loja fica com você.</p></div><ol class="lp-steps"><li><h3>Escolha o seu plano</h3><p>Escolha seu plano no checkout, confirme seu e-mail e pague com Pix. Tem alguma dúvida? O atendimento fica a um toque.</p></li><li><h3>Conecte o seu bot</h3><p>Crie o bot no BotFather e siga o passo a passo protegido para enviar os dados e confirmar sua conta Telegram.</p></li><li><h3>Prepare a sua loja</h3><p>Organize produtos e estoque, personalize a vitrine e configure o pagamento. A equipe acompanha a ativação.</p></li></ol></section>
      <section class="lp-section lp-container lp-faq" id="duvidas" aria-labelledby="lp-faq-title"><div class="lp-section-heading"><h2 id="lp-faq-title">O que você<br>quer saber?</h2><p>Os detalhes de quem vai operar uma loja de verdade.</p></div><div>${faqs.map(([q, a]) => `<details><summary>${q}${icon('plus')}</summary><p>${a}</p></details>`).join('')}</div></section>
      <section class="lp-container lp-contact" id="contratar" aria-labelledby="lp-contact-title"><div><h2 id="lp-contact-title">Sua próxima venda<br>pode começar aqui.</h2><p>Conheça a Blackout e leve sua loja de produtos digitais para o Telegram.</p></div><div class="lp-contact-actions">${cta}<a class="lp-text-link" href="#/entrar">Já sou cliente. Acessar o painel ${icon('arrow')}</a></div></section>
    </main><footer class="lp-footer lp-container"><a class="brand" href="/" aria-label="Blackout Create, início"><img src="/brand.webp" alt="" width="36" height="36"><span>Blackout <small>Create</small></span></a><p>Loja no Telegram. Gestão com a Blackout.</p><a href="#/entrar">Área do cliente ${icon('arrow')}</a></footer></div>`;
}
