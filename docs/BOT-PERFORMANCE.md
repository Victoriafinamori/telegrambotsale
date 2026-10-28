# Navegação do bot

A navegação comum (início, catálogo, categoria, produto, carrinho, pedidos e suporte) usa `POST /internal/bot/updates?dispatch=navigation`. A API valida o runtime e os limites, processa o clique e reserva suas respostas na mesma transação. Leituras independentes usam o mesmo snapshot em paralelo; não há cache de permissões, estoque ou assinatura entre pedidos.

O worker responde ao indicador do botão em paralelo, envia a tela recebida e confirma os resultados em uma chamada de lote. Respostas de navegação são confirmadas atomicamente; uma lease inválida não confirma parcialmente outras mensagens. IDs repetidos são rejeitados. O worker continua compatível com a API antiga caso não receba respostas reservadas.

Checkout, pagamentos, alterações de estoque, entregas, avisos, saques e efeitos diferidos continuam no fluxo durável anterior. Nenhum envio de produto com resultado incerto é repetido automaticamente. A lista permitida de navegação impede que a otimização reserve efeitos financeiros ou de entrega.

## Medições

- Antes: efeitos de tela recentes concluídos cerca de 6,6–7,3 segundos após serem gravados; o pedido com mais mensagens levou 10,9 segundos. Esses valores não incluem o processamento anterior à gravação.
- Primeira otimização: worker mediu 5.054 ms até enviar a tela e 7.650 ms até concluir a confirmação.
- Reserva na própria transação e leituras paralelas: três amostras de 3.421–3.594 ms até enviar a tela, com 6.008–7.052 ms até concluir a confirmação.
- A confirmação final em uma transação reduz o bloqueio entre cliques. Os logs `bot_runtime.navigation_timing` contêm somente tempos numéricos, sem texto, token ou dados do comprador.

Os números são amostras de produção, não garantias de latência nem medições do instante em que o aplicativo do comprador renderiza a alteração. Telegram, rede, contenção e Firestore ainda afetam os tempos. No teste, o Telegram Web demorou a atualizar mensagens editadas mesmo depois da confirmação de envio.

## Validação

Verificação TypeScript, compilação e 117 testes aprovados. Cobertura inclui a redução para duas chamadas HTTP na navegação, replay sem duplicação, leases exclusivas, rejeição de entregas pagas no caminho rápido, revogação de acesso e confirmação de lote sem alterações parciais.

Para reverter, restaure primeiro o worker anterior e depois a API anterior. O frontend não depende dessas rotas internas. Não reprovisione o runtime, troque as chaves ou reinicie o período da assinatura.
