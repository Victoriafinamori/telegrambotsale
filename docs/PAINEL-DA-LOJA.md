# Gestão da loja pelo site

A decisão atual da proprietária é configurar a loja pelo site e aperfeiçoar o menu Telegram depois. **Minha loja** (`#/minha-loja`) abre diretamente o painel quando a loja está aprovada e o aplicativo foi preparado. `#/gestao` permanece como acesso direto. **Ativação e conexão** (`#/configuracao`) reúne o assistente e os dados da contratação, sem obrigar o cliente a passar por essa tela para configurar produtos. A dona pode operar sua loja piloto sem trocar de conta ou de papel. A administração da plataforma continua separada e protegida pelo segundo fator.

Foram localizadas referências antigas da Blackout, mas não um código completo de painel operacional conectado. A organização confirmada pela proprietária — produtos, estoque, pedidos, aparência, suporte e avisos — foi integrada à interface e API atuais. Os mockups não foram tratados como sistemas prontos nem seus dados fictícios foram importados.

## Áreas disponíveis

- **Visão geral:** valores aprovados por moeda, compradores, pedidos entregues e pendências. Os números vêm dos registros da loja.
- **Produtos:** abre primeiro as categorias. O lojista pode criar uma categoria vazia, abri-la e adicionar produtos já vinculados a ela. A edição oferece a seleção de categoria para mover um produto. Categorias dos produtos antigos aparecem automaticamente. Criar/editar nome, descrição, preço, visibilidade e foto opcional continua disponível. Desativar preserva os pedidos anteriores. Categorias não têm banner.
- **Estoque:** adicionar até vinte códigos/textos por envio, cifrados no banco. A reposição usa um identificador de solicitação para impedir duplicação em uma tentativa repetida. Conteúdo de unidades existentes não é retornado ao navegador.
- **Pedidos:** consultar itens, comprador, situação, valor e comprovante, filtrar os que aguardam análise e aprovar ou recusar com motivo. A aprovação exige confirmação do recebimento e usa as mesmas regras transacionais do Telegram.
- **Aparência:** editar mensagem de entrada e banner opcional. O nome do bot continua vindo do BotFather.
- **Suporte:** nome, telefone, link HTTPS e usuário Telegram.
- **Pagamentos:** salvar instruções de Pix/transferência usadas pelo checkout manual. Não há consulta bancária automática. A regra Telegram para bens digitais e o método manual escolhido pela proprietária continuam documentados em `COMPROVANTES-E-AVISOS.md`.
- **Cupons:** criar código, percentual e limite de usos, mantendo registros anteriores.
- **Avisos:** salvar texto/foto em rascunho, rever e confirmar o envio aos inscritos da própria loja, acompanhar o estado ou cancelar próximos envios. Salvar rascunho não envia mensagens.

Fotos de produto, entrada e avisos podem ser enviadas pelo site como JPG/PNG de até 3 MB. A API confere o formato e envia ao bot do próprio responsável confirmado. O navegador nunca recebe o token Telegram. As prévias e comprovantes são obtidos por rotas autenticadas, com limites de tamanho, sem colocar credenciais na URL pública.

O estoque de **arquivos digitais** continua sendo reposto pelo Telegram nesta entrega. O site aceita unidades de texto/código; o envio de uma imagem de vitrine não cria uma unidade de estoque. Arquivos já vendidos continuam sujeitos às regras de entrega e reentrega.

## Conexão e segurança

As rotas `/api/store/manage` verificam Firebase Authentication e derivam a loja pelo UID confirmado. Não aceitam `accountId` como autorização fornecida pelo navegador. Suspensão bloqueia as operações. Acesso a comprovantes é auditado; respostas de pedidos removem ciphertexts e unidades reservadas. O administrador do bot precisa estar confirmado pelo vínculo do Telegram para enviar imagens ou executar ações de aprovação/avisos.

Configurações e produtos usam revisão para impedir que uma tela antiga sobrescreva uma alteração feita em outra tela ou pelo Telegram. Em conflito, atualizar o painel e refazer a edição. As ações de pedidos e avisos passam pelo domínio do bot com IDs exclusivos de solicitação, sem avançar o offset de updates do Telegram nem sobrescrever o formulário em andamento no chat.

O painel reutiliza as cores, tipografia do sistema, botões, cartões, tema claro/escuro e componentes da interface publicada. A navegação lateral tem ícones e grupos de operação/personalização. No computador, o botão ao lado do título recolhe o menu para uma faixa de ícones e o expande novamente; essa preferência visual fica salva no navegador. Recolher não recria formulários nem apaga uma edição em andamento. No celular (até 760 px), o menu abre sobre a página, com botão de fechar, fechamento pelo fundo ou Escape e controle de foco pelo teclado. Escolher uma seção fecha o menu. Foram executados testes de API, domínio e autorização nas entregas anteriores; esta alteração foi validada pela compilação. Naquela entrega a inspeção visual ficou bloqueada pelo acesso ao navegador. O acesso funcionou em 26/10/2026; a validação posterior está registrada abaixo.

## Largura, navegação e prévias (26/10/2026)

O painel de gestão agora ocupa a largura disponível no desktop, com texto e controles maiores. A navegação entre seções já carregadas usa os dados em memória da sessão, sem repetir a consulta completa da loja nem bloquear todos os botões. Pedidos e avisos são carregados ao abrir suas áreas; Atualizar consulta novamente o servidor. Operações de gravação continuam autenticadas e atualizam os dados após salvar. Imagens são carregadas em paralelo e reutilizadas em memória, sem armazenamento persistente de arquivos privados.

Produtos, aparência, suporte, instruções de pagamento e avisos têm uma prévia aproximada do Telegram antes de salvar. Textos e preço acompanham a edição; imagens salvas/enviadas e a opção de remoção aparecem na prévia. A prévia não envia avisos, cria pedidos ou salva as configurações.

Validação desta entrega: compilação TypeScript/Vite aprovada; painel publicado conferido em sessão autenticada, largura do painel acompanhando o viewport e sem transbordamento horizontal; texto da prévia atualizado ao digitar e preservado ao recolher o menu; adaptação em viewport estreito, abertura do menu e fechamento por Escape conferidos por dimensões/árvore de acessibilidade. A captura do desktop foi obtida; a ferramenta não conseguiu capturar a tela durante o override de viewport. Nenhuma configuração da loja foi salva nos testes.

## Categorias antes dos produtos (26/10/2026)

No Telegram, Produtos sempre abre as categorias, mesmo quando há somente uma. O comprador escolhe a categoria, abre o produto e pode voltar à mesma categoria ou à lista completa. Categorias sem produtos visíveis ficam apenas no painel do lojista. Os botões novos usam referência estável ao nome da categoria, evitando abrir outra categoria quando a ordenação muda. Botões antigos com índice continuam aceitos por compatibilidade.

No site, Produtos abre a lista de categorias com contagem e criação de categoria vazia; selecionar uma mostra seus produtos e Adicionar produto já seleciona essa categoria. Produtos antigos são agrupados automaticamente, sem migração destrutiva. Categorias não têm banner. A criação exige UID da loja aprovado e revisão atual. Os emojis e rótulos dos menus do Telegram foram padronizados para catálogo, carrinho, pedidos, comprovantes, pagamentos e administração.

Validação: 42 testes passaram, incluindo categoria única, referências estáveis e criação privada com controle de revisão. Compilação aprovada. API e Hosting publicados; leitura real do banco e health aprovados. Na sessão real, conferidos lista de categorias, abertura de Bots e campo Categoria previamente selecionado no cadastro. Em viewport estreito, não houve transbordamento horizontal. Nenhum produto/categoria de teste foi salvo na loja real.
