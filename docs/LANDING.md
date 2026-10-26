# Página pública Blackout Create

A home mantém a identidade azul-noite da Blackout e apresenta o painel e o bot já implementados. O CTA de contratação/demonstração abre https://t.me/blackoutshopbrbot, conforme solicitado. VITE_CONTACT_URL pode substituir esse destino quando definido com HTTPS válido.

## Conteúdo e provas

- Capturas autênticas da loja piloto em web/public/examples; sem resultados financeiros fictícios.
- O preço visível no produto do Telegram pertence à demonstração, não a um plano de assinatura.
- Gestão de catálogo, estoque, pedidos, aparência, suporte, cupons, avisos e carteira pelo painel.
- Pix integrado Blackout via PurinCash, sujeito à ativação, taxas e liberações; entrega depende da confirmação e do estoque.
- BotFather e confirmações de identidade/saque ainda exigem participação no Telegram. A página não promete dispensar essas etapas.
- Esta mudança não cria um checkout de contratação da plataforma nem define preços ou comissões.

## Publicação e SEO

O plugin prerender-public-landing em vite.config.ts usa a mesma landingPage do cliente para inserir a página completa no HTML de produção. O conteúdo público não depende da API ou de JavaScript para leitura. A área privada continua autenticada e usa noindex no cliente.

A URL canônica e o sitemap apontam para https://blackout-create.web.app/, sem fragmento. Há título/descrição, Open Graph, Twitter Card, JSON-LD sem ofertas ou avaliações inventadas, robots.txt e sitemap.xml. A fonte Manrope e as imagens são hospedadas localmente; a licença da fonte acompanha o arquivo.

Validação: build TypeScript/Vite, HTML pré-renderizado, JSON-LD, arquivos locais, navegação e FAQ; inspeção visual em desktop e larguras móveis de 375 e 320 px; detector de design sem achados e revisão final independente aprovada. Indexação e posição nos buscadores dependem de rastreamento externo e não foram prometidas.
