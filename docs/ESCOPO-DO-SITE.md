# Site da Blackout Create

## Decisão de produto

A página pública divulga o bot de vendas no Telegram e leva à contratação por atendimento ou ao login. A área do cliente serve para conta, primeiros passos, envio protegido dos dados iniciais, ativação e acompanhamento da assinatura. Em 25/10/2026, a proprietária alterou o escopo para priorizar a configuração pelo site: `#/gestao` reúne catálogo, preços, fotos, estoque de códigos/textos, aparência, suporte, instruções de pagamento, cupons, pedidos e avisos. O Telegram usa os mesmos dados e seu menu será aperfeiçoado depois. Consulte `PAINEL-DA-LOJA.md`.

A identidade usa azul associado ao Telegram, fundo azul escuro e verde nas ações de compra, preservando a marca Blackout Create. A demonstração de conversa/pedido é ilustrativa, não uma loja funcionando nem uma prova de vendas. A página identifica o produto como pré-lançamento enquanto a integração operacional estiver pendente.

## Implementado nesta etapa

- Página pública inicial com apresentação, benefícios propostos, prévia ilustrativa do bot, contratação, dúvidas frequentes e acesso à conta.
- Rotas de navegação: `#/` abre a página pública; `#/entrar` abre o login; `#/conta` consulta a sessão e apresenta a área autorizada; convites preservam `#/convite?token=...`.
- A página pública abre sem consultar `/api/config` ou inicializar autenticação. Se a API da área restrita não responder, o visitante continua acessando a apresentação; o login exibe erro controlado e oferece nova tentativa.
- Site público sem campos de token, sem preços inventados, sem depoimentos fictícios ou números de vendas. O token fica exclusivamente no fluxo autenticado de entrada do lojista.
- Nome, criação de conta, recuperação/confirmação de e-mail, envio de token/ID cifrado, revisão administrativa e confirmação manual da ativação já existem na aplicação. A confirmação manual inicia o período e registra vencimento; ela não executa start/deploy na Square Cloud.

## Link comercial

Definir `VITE_CONTACT_URL` com o link público real de atendimento antes de compilar a versão que será publicada. Essa variável é pública e incorporada no bundle do navegador. Não colocar segredos nela. Somente HTTPS sem credenciais na URL é aceito; a saída HTML é escapada. Alterar o valor exige novo build.

Enquanto o proprietário não fornecer um endereço, o botão principal leva à seção de contratação, que informa que os links oficiais ainda serão disponibilizados. Não há formulário de leads, armazenamento de interessados ou envio de mensagens nesta versão.

## Publicação e próximas etapas

Os arquivos públicos compilados podem abrir como conteúdo estático. A área restrita pode usar `VITE_API_ORIGIN` para chamar a API externa com `API_AUTH_MODE=bearer` e CORS exato. O código dessa ligação já existe; a origem real da API, autorização Google e publicação ainda estão pendentes. Manter Spark e a Square Cloud existente; ver `PUBLICAR-FIREBASE-SPARK.md`.

Em 25/10/2026, infraestrutura, publicação e segundo fator da dona já foram validados. O runtime do bot digital e sua ligação com o cadastro estão implementados; o piloto Telegram real permanece necessário. Há renovação mensal registrada pelo administrador, lembretes e bloqueio de novas vendas por vencimento, sem cobrança financeira automática da assinatura. Consulte `BOT-TELEGRAM.md`.

Os testes de navegador cobrem apresentação com API indisponível, acesso ao login, recuperação de conectividade, navegação, FAQ e larguras de 320 a 1440 pixels, além do fluxo existente de convite/ativação. As imagens em `.local/screenshots/landing-*.png` representam testes locais, não uma URL publicada.
