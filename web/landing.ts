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
const arrow =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>';
const plane =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="m21.3 3.2-3.4 16.1c-.3 1.1-1 1.4-2 .9l-5.2-3.8-2.5 2.4c-.3.3-.6.6-1.1.6l.4-5.3 9.6-8.7c.4-.4-.1-.6-.6-.3L4.6 12.6l-5.1-1.6c-1.1-.3-1.1-1.1.2-1.6L19.6 1.7c.9-.3 1.8.2 1.7 1.5Z" transform="translate(1 1) scale(.94)"/></svg>';
export function landingPage(contact: string | null, signedIn = false) {
  const action = contact
    ? `<a class="lp-button" data-contact-link href="${esc(contact)}" target="_blank" rel="noopener noreferrer">Conversar com a equipe ${arrow}</a>`
    : '<p class="lp-contact-pending">Contratação por atendimento. Os links oficiais de contato serão disponibilizados aqui. Se já falou com a equipe, continue pelo mesmo canal.</p>';
  return `<div class="landing-page">
    <a class="lp-skip" href="#conteudo">Pular para o conteúdo</a>
    <header class="lp-header">
      <a class="brand" href="#/" aria-label="Blackout Create, início"><img src="/brand.webp" alt="" width="44" height="44"><span>Blackout <small>Create</small></span></a>
      <nav class="lp-nav" aria-label="Navegação principal"><a href="#experiencia">A experiência</a><a href="#como-funciona">Como funciona</a></nav>
      <a class="lp-login" id="landing-login" href="#/entrar">${signedIn ? 'Minha área' : 'Entrar'} ${arrow}</a>
    </header>
    <main id="conteudo">
      <section class="lp-hero lp-container" aria-labelledby="lp-title">
        <div class="lp-hero-copy"><span class="lp-eyebrow"><i aria-hidden="true"></i> Blackout Create · Pré-lançamento</span><h1 id="lp-title">Seu próximo pedido<br>começa no<br><span class="lp-telegram-word">Telegram.<span class="lp-telegram-icon">${plane}</span></span></h1><p>Transforme seu bot em uma loja de produtos digitais. Catálogo, pedidos e entrega na conversa que seu cliente já usa.</p><div class="lp-actions"><a class="lp-button" href="#contratar">Quero meu bot de vendas ${arrow}</a><a class="lp-text-link" href="#como-funciona">Conhecer a proposta <span aria-hidden="true">↓</span></a></div><div class="lp-hero-note"><span aria-hidden="true">✦</span> Sua marca na vitrine. Seus produtos na conversa.</div></div>
        <figure class="lp-preview"><div class="lp-phone"><div class="lp-phone-top"><span class="lp-store-avatar" aria-hidden="true">S</span><div><b>Sua loja</b><small>Bot no Telegram</small></div><span class="lp-phone-menu" aria-hidden="true">···</span></div><div class="lp-chat"><div class="lp-bot-message"><div class="lp-shop-banner"><span class="lp-eclipse" aria-hidden="true"></span><span>SUA LOJA DIGITAL<br><b>PRONTA PARA O PRÓXIMO PEDIDO.</b></span></div><div class="lp-message-copy"><b>Bem-vindo à sua loja ✨</b><p>Seus produtos digitais, em poucos toques.<br>Escolha por onde começar.</p></div></div><div class="lp-keyboard" aria-hidden="true"><span>Explorar produtos <i>→</i></span><span>Ofertas <i>→</i></span><span>Meus pedidos <i>→</i></span></div><div class="lp-demo-order"><span aria-hidden="true">✓</span><div><b>Pedido confirmado</b><small>O próximo passo é a entrega.</small></div>${arrow}</div><div class="lp-chat-label">Exemplo ilustrativo de uma jornada de compra.</div></div></div><figcaption>Prévia ilustrativa da experiência proposta para o bot.</figcaption></figure>
      </section>
      <div class="lp-divider lp-container"><span>Da vitrine ao pedido.</span><span>Uma experiência de compra dentro do Telegram.</span></div>
      <section class="lp-section lp-container" id="experiencia" aria-labelledby="lp-experience-title"><div class="lp-section-heading"><span class="lp-eyebrow">A experiência que estamos preparando</span><h2 id="lp-experience-title">Venda na conversa.<br>Gerencie no Telegram.</h2><p>A experiência que conecta seus produtos ao próximo cliente.</p></div><div class="lp-features"><article><span class="lp-feature-icon" aria-hidden="true">✦</span><h3>Uma vitrine com a sua marca</h3><p>Apresente seus produtos digitais em categorias, com imagens e informações de compra.</p></article><article><span class="lp-feature-icon">${plane}</span><h3>Controle na palma da mão</h3><p>Gerencie produtos, estoque e pedidos pelo menu administrativo do seu bot.</p></article><article><span class="lp-feature-icon" aria-hidden="true">◷</span><h3>Pedidos com continuidade</h3><p>Uma jornada de compra com carrinho, acompanhamento do pagamento e entrega do produto.</p></article></div></section>
      <section class="lp-section lp-container" id="como-funciona" aria-labelledby="lp-how-title"><div class="lp-how"><div class="lp-section-heading"><span class="lp-eyebrow">Do primeiro contato à ativação</span><h2 id="lp-how-title">Você começa.<br>A gente acompanha.</h2><p>Contratação com atendimento e orientação para preparar seu bot.</p><a class="lp-text-link" href="#contratar">Conversar sobre a contratação ${arrow}</a></div><ol class="lp-timeline"><li><span>01</span><div><h3>Converse com a equipe</h3><p>Alinhe sua contratação pelo canal de atendimento da Blackout Create.</p></div></li><li><span>02</span><div><h3>Receba seu convite</h3><p>Crie seu acesso e siga o passo a passo para enviar os dados do seu bot com segurança.</p></div></li><li><span>03</span><div><h3>Acompanhe a ativação</h3><p>A equipe prepara e testa o bot. Seu período mensal começa após a confirmação da ativação.</p></div></li></ol></div></section>
      <section class="lp-section lp-container" id="duvidas" aria-labelledby="lp-faq-title"><div class="lp-faq"><div class="lp-section-heading"><span class="lp-eyebrow">Antes de começar</span><h2 id="lp-faq-title">Sem complicar.</h2></div><div><details><summary>Onde vou configurar minha loja?</summary><p>No menu administrativo do seu bot, dentro do Telegram. O site fica para seu acesso, orientação inicial, ativação e acompanhamento da assinatura.</p></details><details><summary>Preciso criar meu próprio bot?</summary><p>Sim. Você cria o bot no BotFather e segue nosso passo a passo para informar os dados em um formulário protegido. A equipe cuida da preparação da hospedagem.</p></details><details><summary>Como meu cliente paga?</summary><p>O fluxo previsto inclui Pix manual e envio de comprovante, com análise do vendedor antes da confirmação. As condições e funcionalidades disponíveis serão alinhadas na contratação.</p></details><details><summary>Quando começa o período mensal?</summary><p>Depois que a equipe confirmar a ativação do bot. Criar uma conta ou enviar os dados não inicia o período.</p></details><details><summary>Como funciona a contratação?</summary><p>A contratação é alinhada com a equipe. Após a conferência, você recebe um convite de acesso no e-mail cadastrado. Criar uma conta não confirma uma compra.</p></details></div></div></section>
      <section class="lp-container lp-contact" id="contratar" aria-labelledby="lp-contact-title"><div><span class="lp-eyebrow">Seu próximo passo</span><h2 id="lp-contact-title">Seu produto merece<br>o próximo pedido.</h2><p>Conheça a proposta do seu bot de vendas e alinhe as condições com a Blackout Create.</p></div><div class="lp-contact-actions">${action}<a class="lp-text-link" href="#/entrar">Já sou cliente. Acessar minha conta ${arrow}</a></div></section>
    </main><footer class="lp-footer lp-container"><a class="brand" href="#/"><img src="/brand.webp" alt="" width="36" height="36"><span>Blackout <small>Create</small></span></a><p>Blackout Create. Sua loja no Telegram.</p><a href="#/entrar">Área do cliente ${arrow}</a></footer>
  </div>`;
}
