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

Nenhuma taxa, comissão, valor mínimo ou permissão foi alterada. Não é feita uma transferência adicional para detalhar a carteira. Consulta automática de saque já em processamento e confirmação final pelo Telegram permanecem com as mesmas proteções anteriores.

## Validação

`tests/wallet-breakdown.test.ts` cobre a equação financeira, taxas ausentes/zeradas, nomenclatura do saque, dados inconsistentes, cruzamento por subconta, sinais do extrato e isolamento de identidade. O transporte simulado rejeita qualquer POST nesse teste de leitura.

Referência oficial consultada em 27/10/2026: https://docs.purincash.com/guias/subcontas
