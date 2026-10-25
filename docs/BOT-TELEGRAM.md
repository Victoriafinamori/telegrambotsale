# Operação do bot de produtos digitais

Atualização: a proprietária acrescentou foto opcional por produto, suporte completo, avisos, histórico detalhado, estatísticas e comprovantes Pix/transferência com análise manual. Leia [COMPROVANTES-E-AVISOS.md](COMPROVANTES-E-AVISOS.md), que descreve o modo atual e a diferença em relação à regra de Stars para produtos digitais. As seções Stars abaixo continuam como referência do modo automático disponível.

## Arquitetura

Cada lojista tem um processo Node.js exclusivo na Square Cloud. Ele consulta atualizações diretamente no Telegram por long polling e encaminha os eventos à API central através de uma credencial aleatória exclusiva da loja. Não recebe Firebase Admin, senha Google, chave de criptografia ou acesso a outras lojas. A API confere a credencial e sua geração em cada operação, lê a situação da contratação e persiste os dados no Firestore privado.

`server/bot-store.ts` implementa o domínio transacional. `server/bot-runner.ts` é o processo do aplicativo do lojista. `server/bot-runtime-routes.ts` oferece a conexão privada em `/internal/bot`. As rotas do site continuam usando Firebase Authentication e o segundo fator do administrador.

O token do Telegram é aberto somente para o processo autorizado, por HTTPS, e permanece na memória. Estoque de texto/arquivo e mensagens da fila de entrega ficam cifrados no banco com a chave já existente. Não trocar essa chave sem recifrar os dados.

## Preparar uma loja

1. No site, cadastrar a contratação, confirmar o pagamento recebido, gerar o convite e aprovar o lojista. O lojista cria/confirma seu acesso, valida e envia o token e seu ID pessoal do Telegram pelo formulário protegido.
2. Na aba Ativações, marcar **Em configuração**. Não iniciar a mensalidade nessa etapa.
3. Compilar a aplicação e preparar o pacote público do processo:

   ```sh
   npm run build
   npm run bot:package
   ```

   O segundo comando cria uma pasta nova em `.local/bot-package-*` com apenas dois módulos compilados, dotenv fixado no lockfile e a configuração Square Cloud. Compactar o conteúdo dessa pasta. Não incluir `.local/` inteira, `.env`, credenciais ou dados do servidor central.

4. Enviar o pacote como **novo aplicativo exclusivo** na Square Cloud, com 256 MB livres e Node recomendado (24 na configuração consultada). O processo é `dist-server/server/bot-runner.js`. Ele não precisa de subdomínio público: usa conexões de saída. Se não houver memória, liberar capacidade ou decidir sobre o plano com a proprietária; não parar aplicativos existentes automaticamente.
5. Com a configuração administrativa privada já instalada no computador/servidor de operação, gerar a credencial limitada:

   ```sh
   npm run bot:credential -- --account UUID_DA_LOJA --app ID_REAL_SQUARE
   ```

   O comando salva um arquivo privado em `.local/bot-runtimes/`, sem imprimir seu conteúdo. Instalar `BOT_API_ORIGIN` e `BOT_RUNTIME_KEY` exclusivamente no ambiente privado desse aplicativo Square Cloud. Não enviar o arquivo ao Git nem ao chat. Conferir ACL no Windows; os arquivos privados devem continuar restritos à proprietária, ao executor e ao sistema. Reiniciar somente o novo aplicativo.

   Reexecutar a geração substitui a credencial anterior; o processo antigo perde acesso. Para revogar:

   ```sh
   npm run bot:credential -- --account UUID_DA_LOJA --app ID_REAL_SQUARE --revoke
   ```

6. O processo confere `getMe` contra o ID do bot cadastrado e recusa iniciar se houver webhook. Uma migração de servidor existente deve ser combinada antes de retirar seu webhook/processo; o runner não apaga configurações do Telegram automaticamente.
7. O lojista atualiza o site e usa **Confirmar minha conta no Telegram**. Abre o link com a conta cujo ID informou e toca em Iniciar. O vínculo é exclusivo, vence em dez minutos e não concede administração a quem apenas conhece um ID. Depois, `/admin` libera o menu da loja.
8. Configurar atendimento, produto e estoque pelo Telegram. Conferir conexão e responsável no site. A ativação pela plataforma exige runtime provisionado/online, identidade confirmada e aplicativo correspondente. A equipe continua atestando o teste; só então o período mensal começa.

## Menu do lojista no Telegram

`/admin` abre criação e edição de produtos, disponibilidade, categorias, reposição de estoque, banner, mensagem inicial, atendimento, cupons e pedidos. `/cancelar` interrompe o formulário. Produtos têm preço inteiro em Telegram Stars. O estoque aceita uma unidade de conteúdo por linha ou um arquivo por mensagem. Arquivos permanecem no Telegram; o banco cifra seu `file_id`.

Limites iniciais explícitos: 40 produtos por loja, 100 unidades disponíveis por produto, até 20 unidades por mensagem de reposição, 20 cupons, dez unidades por carrinho e 25 reservas simultâneas. Textos de estoque têm limite de aproximadamente mil caracteres por unidade. Listagens exibem pedidos recentes; registros históricos persistem no banco.

Clientes usam `/start`, catálogo/categorias, carrinho, cupom, checkout, `/pedidos` e `/paysupport`. Mensagens de grupo não podem administrar ou comprar. O pedido pertence ao ID real do comprador recebido do Telegram.

## Pagamento, estoque e entrega

Produtos digitais vendidos dentro do Telegram usam **Telegram Stars (`XTR`)**. Não há Pix para arquivos/códigos no checkout deste bot. A assinatura Blackout contratada com a plataforma é uma operação separada da venda dos produtos do lojista.

O checkout reserva o estoque e o cupom atomicamente por vinte minutos. A confirmação de pré-checkout confere comprador, moeda, total, reserva, liberação e vencimento. Somente `successful_payment` agenda a entrega. O identificador da cobrança e os updates são deduplicados. Cancelamento/vencimento libera a reserva; pagamento tardio ou incompatível é retido para revisão/reembolso, sem retirar outra unidade.

A fila cifra o conteúdo e exige uma concessão de envio antes de executar a chamada Telegram. Confirmação perdida/timeout deixa o resultado incerto; reiniciar não reenvia automaticamente. A entrega só é marcada concluída após confirmação de todos os conteúdos. O lojista pode solicitar a reentrega explícita do **mesmo conteúdo**, sem consumir estoque novamente. Telegram não oferece uma chave de idempotência geral para `sendMessage`/`sendDocument`: não é possível prometer envio exatamente uma vez em uma falha de rede ambígua.

Reembolso Stars exige duas ações explícitas do responsável no pedido. Não repõe ao estoque conteúdo já revelado. Um resultado incerto no reembolso exige reconciliação manual da cobrança; não repetir uma operação financeira às cegas. Pagamentos reais/reembolsos reais não fazem parte dos testes automatizados.

## Vencimento e renovação

Novos pedidos são bloqueados se o acesso for suspenso, o bot não estiver ativo ou o período vencer. Reiniciar o processo não reativa vendas. Pagamentos já confirmados continuam sendo tratados para entrega ou revisão, e o atendimento continua disponível. O heartbeat agenda lembretes persistidos para 10, 5, 3, 1 dia e vencimento, sem repetir o mesmo aviso no mesmo período.

O administrador usa **Registrar renovação mensal** no cadastro do lojista após confirmar o pagamento externo. A rota protegida `POST /api/admin/accounts/:id/renew` exige `paymentConfirmed: true` e um `requestId` UUID exclusivo. O mesmo identificador não acrescenta dois meses. Não há cobrança financeira automática nem recebimento Pix da assinatura implementado por essa rota.

## Verificação e limites operacionais

`tests/bot-runtime.test.ts` cobre ligação do responsável, credenciais por loja e revogação, catálogo, cupons, reserva concorrente, pagamentos repetidos/tardios, arquivo cifrado, entrega incerta, reentrega, reembolso, renovação e ligação HTTP do site ao runner com transporte Telegram simulado. Isso não substitui um piloto com BotFather, conta de lojista e pagamento no ambiente de teste oficial do Telegram.

Ainda é necessário executar esse piloto antes de afirmar que uma loja real está operando. Provisionamento/upload Square Cloud é feito pela equipe; não há um botão de criação automática de aplicativos no painel. Backup/restauração, retenção dos updates/filas e monitoramento de cota continuam exigindo operação própria. Firestore Spark tem cotas finitas: heartbeats, estoque e pedidos consomem leituras/escritas. Esta arquitetura não promete quantidade ilimitada de bots no plano gratuito.

Referências: [Bot API](https://core.telegram.org/bots/api), [pagamento de produtos digitais](https://core.telegram.org/bots/payments-stars), [links de vínculo](https://core.telegram.org/bots/features#deep-linking), [Node.js na Square Cloud](https://squarecloud.app/pt-br/runtimes/nodejs).
