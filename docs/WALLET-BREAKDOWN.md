# Transparência da carteira

A carteira apresenta saldo total, bloqueio por disputas, saldo disponível e horário da consulta à Purin. O disponível é o montante informado pelo provedor como liberado; as tarifas do saque ainda saem do valor solicitado. Pagamentos manuais e Mercado Pago continuam fora desta carteira.

## Vendas

O extrato mostra as últimas 20 movimentações da subconta, preservando sinais de créditos/débitos e referências. Não apresenta esse recorte como total de toda a conta. Para cada lançamento `sale`:

- O líquido creditado vem de `transaction.amountCents`.
- A taxa Blackout vem do `transaction.feeCents` histórico da própria venda, sem recalcular pela configuração atual.
- O bruto vem do pedido Blackout com o mesmo `purin_payment_id`, método Purin, moeda BRL e a mesma subconta. Ausência, duplicidade ou vínculo diferente impedem a associação.
- A tarifa Purin é conciliada como **bruto − crédito líquido − markup Blackout**. Só é apresentada se todos os campos estiverem presentes, forem inteiros válidos e a soma for coerente.

Campos ausentes não viram zero. O extrato informa detalhamento incompleto/em conferência quando a conciliação não for possível. Os valores vêm das leituras do provedor e do pedido autenticado; não são usadas taxas tabeladas atuais para reconstruir o passado. Vendas externas à Blackout podem aparecer como crédito sem bruto identificável.

## Saques

Na consulta `GET /v1/subaccounts/{id}/payouts/{payoutId}`, a nomenclatura do provedor é:

- `amountCents`: débito solicitado da subconta.
- `feeCents`: markup da Blackout.
- `platformFeeCents`: tarifa de saque da Purin.
- `netAmountCents`: líquido destinado ao Pix.

O backend preserva as duas taxas separadas e só soma um total quando ambas forem informadas. O líquido, quando disponível, continua sendo conferido contra o valor solicitado. Saques antigos sem a separação mostram “Não informado”; o controle de atualização permite recuperar dados atuais também para saques concluídos.

O acompanhamento distingue criação, autorização no site, confirmação no Telegram, processamento, conclusão e devolução. Datas de conclusão/devolução só aparecem quando informadas pela consulta do provedor. Saques com estorno exibem que o valor integral, incluindo taxas, foi devolvido. Solicitações em processamento orientam a conferir antes de repetir.

O detalhamento histórico não altera taxas nem faz transferências adicionais. A carteira usa as taxas reais configuradas na subconta; valores ausentes do provedor continuam como “Não informado”.

## Confirmação e chaves Pix

Cada saque novo registra seu canal de origem (`web` ou `telegram`). A confirmação final ocorre nesse canal, sem exigir autorização no outro. `/wallet/approve` executa uma solicitação web do lojista autenticado; `wallet:confirm` executa uma solicitação do Telegram do responsável vinculado. As duas entradas preservam a conferência de saldo, conexão, validade, alteração de taxas, trava transacional e chave de idempotência. Uma resposta ambígua continua em processamento e nunca repete o POST ao provedor.

As chaves Pix são cifradas por loja, deduplicadas e limitadas a dez. A API de listagem expõe somente nome, tipo e destino mascarado. O lojista pode adicionar e remover pelo site ou Telegram. Remover uma chave salva não muda o destino de um saque já preparado: ele conserva os dados cifrados que o lojista conferiu.

O layout tem cartões de saldo, filtros de saques, extrato e chaves Pix. O formulário mostra o valor solicitado, a comissão Blackout e o valor após essa comissão. A tarifa Purin é adicional e o líquido final só é apresentado como confirmado quando informado pelo provedor. Não se presume tarifa zero.

## Validação

`tests/wallet-breakdown.test.ts` cobre a equação financeira, taxas ausentes/zeradas, nomenclatura do saque, dados inconsistentes, cruzamento por subconta, sinais do extrato e isolamento de identidade. O transporte simulado rejeita qualquer POST nesse teste de leitura.

Referência oficial consultada em 27/10/2026: https://docs.purincash.com/guias/subcontas
