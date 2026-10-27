# Saúde dos bots

A administração da plataforma tem a aba **Saúde dos bots** e a rota `#/saude`. O acesso à API é exclusivo de administradores com segundo fator confirmado, seguindo a mesma política do restante da administração.

## Consulta

- Conexão: heartbeat do runtime nos últimos 90 segundos. Os estados distinguem conectado, sem sinal recente, aguardando primeiro sinal, não publicado, credencial revogada e vínculo diferente. “Sem sinal” não prova que o processo na hospedagem parou; pode haver falha na conexão com a API. Não há chamadas à Square ou Hyze para consultar processos nesta tela.
- Pagamentos: separa pedidos aguardando comprador, comprovantes para o lojista, geração de cobrança sem confirmação local, prazos encerrados com registro ainda aberto e pedidos em revisão/reembolso. A existência de um payment ID impede tratar uma cobrança já gerada como tentativa ambígua. A tela não consulta nem confirma pagamentos no gateway.
- Entregas: pedidos pagos sem entrega confirmada, efeitos de entrega falhos, incertos ou com concessão de envio sem confirmação por mais de dois minutos. Pedidos reembolsados/encerrados não são apresentados como falha de entrega ativa a partir de efeitos antigos. Resultados incertos não são reenviados pelo monitoramento.
- Ativações: fila, publicação, configuração, espera pelo responsável e exceções como falta de memória. Jobs do provedor anterior precisam de conferência explícita. A situação da nova hospedagem Hyze, inclusive pausa ou ausência de conexão, aparece separadamente dos bots já publicados.
- Contratações e renovações: cobranças da plataforma, separadas das vendas dos lojistas. Mostra status, valor e referência, sem QR Code ou dados do pagador.

## Limites e atualização

Cada consulta cobre dez lojas com paginação por cursor. Contadores e filtros se referem somente à página atual. Por loja, lê até 25 pedidos recentes, 25 pedidos abertos e amostras de até vinte efeitos por status (falho/incerto/em envio). Os pedidos relacionados a efeitos da amostra também são consultados. Quando encontra mais registros além dessas amostras, o painel avisa que a leitura foi limitada. Não representa auditoria completa de todo o histórico.

As cobranças de assinatura são uma amostra separada das trinta mais recentes. O painel informa quando existem registros mais antigos fora da amostra; não afirma que não há pendências antigas.

A tela atualiza a cada minuto enquanto estiver aberta e visível, além do botão manual. A última consulta aparece com data/hora; falhas de atualização são informadas sem declarar os dados anteriores como novos. Não foi criada automação de mensagens, e-mail ou Telegram em segundo plano.

## Ações e privacidade

**Conferir loja e ativação** abre a ficha administrativa, inclusive quando a loja não está na primeira página da listagem comum. O endpoint de detalhes usa uma lista explícita de campos públicos administrativos. O painel de saúde não retorna tokens, credenciais, payloads de entrega, conteúdo de estoque, comprovantes ou dados privados dos compradores.

São leituras: nenhum botão reinicia aplicativos, ativa bots, aprova pagamentos, executa reembolsos ou reenvia produtos. Os alertas orientam a conferir uma entrega antes de repetir, preservando a política de resultados incertos.

`tests/admin-health.test.ts` cobre sinais do runtime, suspensão, vínculo incorreto, cobranças ambíguas, comprovantes, falhas e incerteza de entrega, exceções de ativação, paginação, leituras limitadas e autorização HTTP com MFA.
