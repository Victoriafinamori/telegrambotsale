# Pagamentos da loja: Pix manual e Mercado Pago

A aba Pagamentos permite escolher Pix/transferência manual ou Pix automático pelo Mercado Pago. Cada lojista conecta sua própria conta. Nenhuma credencial Mercado Pago pertence ao frontend ou ao processo do bot.

## Pix manual

Até três chaves com tipo CPF, CNPJ, e-mail, celular ou aleatória, valor e nome do recebedor. CPF/CNPJ têm validação de dígitos; celular usa +55 e DDD; chave aleatória usa UUID. As chaves são normalizadas ao salvar e aparecem junto às instruções adicionais no Telegram. O comprovante e a aprovação manual continuam funcionando. O QR estático de produto é usado apenas nas condições documentadas em PIX-E-BANNERS.md.

## Conectar Mercado Pago

1. No Mercado Pago Developers, abrir a aplicação da conta recebedora da loja. A conta deve ser do Brasil e estar habilitada para receber Pix.
2. Em Webhooks de produção, configurar a URL individual mostrada em Pagamentos e habilitar o evento Pagamentos.
3. No formulário do site, informar o Access Token de produção e a assinatura secreta do webhook. Não enviar os valores pelo chat, Git ou Telegram.
4. Clicar em Conectar minha conta. A API valida o token em `/users/me`, registra a identidade da conta e cifra as credenciais.
5. Selecionar Pix automático e salvar a forma de pagamento. O cadastro de chaves manuais pode ser preservado para uma futura troca de modo.

O formulário não mostra credenciais salvas. Trocar credenciais cria uma versão nova; pedidos pendentes mantêm a versão original para validar suas notificações. A URL do painel usa `/payments/mercadopago/<loja>/current`; cobranças criadas pela API usam uma URL vinculada à versão da conexão. Isso permite configurar as notificações antes de conectar as credenciais no site.

Na API central, `API_PUBLIC_ORIGIN` deve conter a origem HTTPS real da API, sem caminho ou barra final. Na instalação atual: `https://blackout-create-api.squareweb.app`. `APP_ORIGIN` continua sendo o site do Firebase Hosting.

## Compra e confirmação

O bot reserva o estoque e envia um link de pagamento individual. O comprador abre a página web, informa e-mail e CPF/CNPJ e gera o Pix. Esses dados são enviados ao Mercado Pago para processar o pagamento e ficam cifrados no armazenamento privado da API. O valor é calculado pelo servidor a partir do pedido, incluindo itens, quantidades e cupom. O navegador não pode escolher o valor nem marcar um pagamento como aprovado.

A cobrança retorna QR Code e Pix copia e cola. Tentativas repetidas usam a mesma chave de idempotência e os mesmos dados de criação, mesmo se uma resposta se perder. No Pix automático, o prazo é de 60 minutos; a primeira geração fixa um prazo de 60 minutos para a cobrança. O Mercado Pago exige pelo menos 30 minutos de validade. O Pix manual mantém a reserva de 20 minutos.

Webhooks exigem assinatura HMAC e timestamp recente. O servidor consulta `/v1/payments/<id>` com a credencial da conexão correspondente e confere conta recebedora, referência da loja/pedido, moeda BRL, método Pix, valor exato e ambiente de produção. Somente `approved` agenda a entrega; eventos repetidos não repetem a entrega ou as estatísticas. Há consulta manual de confirmação na página e pelo botão do Telegram; nenhum desses botões aprova por declaração do comprador.

Pagamento recebido após cancelamento, vencimento ou bloqueio da loja fica em revisão/reembolso, sem nova entrega. Cancelamento/recusa do provedor libera a reserva que ainda estava pendente. Estornos e contestações atualizam o pedido e impedem entregas ainda não enviadas. Reembolsos financeiros são tratados pelo lojista no Mercado Pago; esta implementação não executa transferências ou reembolsos bancários automaticamente.

As entregas usam os mesmos efeitos cifrados, leases e confirmações do bot. A API tenta despachar a entrega imediatamente; se necessário, o worker existente coleta os efeitos pendentes. Resultados ambíguos de envio não são reenviados automaticamente.

## Validação e limites

Testes usam transportes Mercado Pago/Telegram simulados e banco de domínio em memória. Cobrem cobrança repetida após falha de rede, credenciais/dados do pagador cifrados, capacidade individual do checkout, assinaturas inválidas/vencidas, valor/recebedor/moeda/ambiente incorretos, entrega única, cancelamento, pagamento tardio, estorno e troca de credenciais com pedido pendente. Testes HTTP cobrem rotas privadas, origem do checkout, impossibilidade de alterar o total e webhook assinado sem sessão de navegador.

A ativação de uma conta real e uma compra real dependem do preenchimento privado das credenciais pelo lojista e da configuração do webhook no Mercado Pago. Não afirmar que houve cobrança ou pagamento real apenas porque testes, publicação e health passaram. Projetos demo e emuladores bloqueiam chamadas de pagamento reais; os testes injetam transporte simulado. As exigências do Telegram para bens digitais continuam documentadas em COMPROVANTES-E-AVISOS.md; o Pix automático desta integração é gerado na página web, e o Telegram recebe o estado e a entrega do pedido.

Na sessão publicada foram conferidos os cinco tipos de chave, a prévia ao digitar um e-mail de teste (sem salvar), a troca para Pix automático e o bloqueio de ativação sem conta conectada. Em viewport estreito, o formulário não apresentou transbordamento horizontal. A captura de tela ficou indisponível; a conferência usou acessibilidade e dimensões do DOM. A leitura real confirmou o modo manual, zero chaves e conta Mercado Pago ainda não conectada. Health passou e as rotas recusaram acesso anônimo às configurações e webhook sem assinatura. A suíte completa passou com 50 testes; após os ajustes finais de estorno parcial e proteção do ambiente demo, os 31 testes de bot/pagamentos foram repetidos e passaram.

Referências: [Pix via API Payments](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix), [validação oficial de webhooks](https://github.com/mercadopago/sdk-nodejs/blob/master/docs/webhooks.md).
