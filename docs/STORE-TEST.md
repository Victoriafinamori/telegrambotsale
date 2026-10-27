# Modo de teste da loja

O lojista abre **Minha loja → Testar loja**, escolhe código fictício ou arquivo de exemplo e inicia a simulação. Também há um atalho na visão geral e a rota `#/gestao?section=test`.

O teste cria uma cópia do catálogo com categorias, emojis, preços, disponibilidade, descrição, banner e atendimento. Cada produto recebe no máximo dez unidades fictícias, respeitando o estoque disponível na hora da cópia. Produtos zerados continuam zerados; o controle **Repor 1** só altera a cópia. Os códigos e arquivos do estoque verdadeiro nunca são lidos nem clonados.

## O que é exercitado

A mesma classe `BotStore` processa os comandos de comprador, navegação, carrinho, cupom, criação e cancelamento de pedido, comprovante, aprovação/recusa e agendamento/confirmação de entrega. Ela recebe `TestDocumentStore`, um adaptador exclusivamente local, sem referência ao banco de produção. Toda reserva, pedido, comprador, efeito, estatística e auditoria produzidos pelo bot ficam nessa cópia.

As mensagens e botões retornados são exibidos em uma conversa aproximada no painel. Os controles financeiros atuam no pedido fictício pendente mais recente, identificado na tela. Links externos e ações administrativas arbitrárias não são executados pelo simulador. Banners já salvos podem ser consultados por leitura através da rota privada de mídia existente; isso não envia mensagens ao Telegram.

- Pix: comprovante fictício, aprovação ou recusa simulada usam o fluxo local de revisão do pedido.
- Pix automático Purin/Mercado Pago: a configuração do provedor é indicada, mas a aprovação é reproduzida localmente pelo fluxo de pagamento manual da cópia. Não são usados credenciais, cobranças, QR Codes nem webhooks reais. Este recurso não valida a integração financeira externa.
- Stars: o simulador reproduz um evento de pagamento aprovado na cópia; nenhuma fatura ou solicitação é enviada ao Telegram.
- Entrega: códigos são gerados como `BLACKOUT-TESTE-...`; o arquivo disponível para baixar é um texto de exemplo criado no navegador. Nenhum arquivo do inventário real é acessado.

O usuário visualiza separadamente as mensagens do comprador, do lojista e o histórico dos pedidos de teste. Teste local não substitui uma transação real ou uma confirmação de entrega via Telegram.

## Isolamento e retomada

O único registro de produção escrito pelo serviço é `merchant_test_sessions/<accountId>`. O conteúdo da cópia é cifrado com contexto específico por loja e sessão, sem credenciais de provedores ou produtos reais. É mantida uma sessão por loja; iniciar outra substitui apenas a simulação anterior. Ela pode ser retomada em outra aba/sessão por duas horas, com limite de sessenta ações e tamanho máximo de estado.

As rotas derivam a loja da identidade Firebase, exigem acesso aprovado e validam o dono novamente na transação. Payloads estritos não aceitam `accountId`, valor de pagamento ou comandos administrativos. ID da sessão, revisão e requestId evitam ações em sessões substituídas, alterações concorrentes e entregas duplicadas na retomada de uma resposta perdida. Dados de uma conta suspensa não ficam disponíveis no simulador.

Os efeitos Telegram são coletados pelo próprio simulador e confirmados apenas no adaptador local. Não há executor de transporte de rede, cliente de gateway ou runtime key nessa execução. Nenhum saldo, venda, assinatura ou configuração de ativação real é alterado.

Sessões expiradas deixam de ser utilizáveis. O registro cifrado permanece até ser substituído por um novo teste; não foi configurada uma regra TTL adicional no Firestore.

## Verificação

`tests/store-test.test.ts` verifica entrega fictícia, cancelamento/recusa, retomada, expiração, cifra, autorização HTTP, comandos proibidos, aprovação repetida e estoque isolado. Os testes com modos Purin/Mercado Pago/Stars bloqueiam `fetch` para detectar qualquer tentativa de chamada externa. Um adaptador auditado comprova que o serviço só grava no registro de teste e não lê as coleções de inventário real.
