# Carteira e saques dos lojistas

A carteira do site e `/carteira` ou `/admin → Carteira` no Telegram mostram apenas a subconta PurinCash vinculada à loja. Compradores não acessam esse menu. Pix manual e saldo do Mercado Pago não são contabilizados como dinheiro custodiado pela Blackout.

São exibidos saldo total, disponível, valor bloqueado por MED, últimas movimentações e histórico dos saques pedidos pela Blackout. O limite de cada solicitação usa `availableCents`, nunca o saldo da conta principal. Saques feitos diretamente na PurinCash continuam aparecendo no extrato de movimentações da subconta.

## Habilitação pela dona

1. Na PurinCash, na chave de produção já conectada, habilitar somente a permissão adicional **Sacar de subconta**. Não é necessário dar permissão para saques da conta principal, cripto ou movimentação geral da carteira.
2. No painel administrativo Blackout, com segundo fator confirmado, habilitar **Saques das subcontas**. O padrão é desativado; trocar a conexão PurinCash desativa novamente os saques até revisão.
3. O provedor também exige conta habilitada para saques, podendo exigir aprovação do primeiro saque. Mínimos, tarifas, disponibilidade e limites de frequência são impostos pela PurinCash.

## Fluxo de autorização

- Site: o lojista informa valor bruto, tipo e chave Pix; confere os dados e autoriza. A API envia a confirmação ao Telegram pessoal vinculado à loja.
- Telegram: o lojista também pode iniciar em Carteira → Sacar, informar valor e chave e abrir o botão **Conferir e autorizar no site**. O site exige a identidade Firebase do proprietário e mostra os dados completos.
- Nos dois casos, o envio final ocorre somente no botão **Confirmar saque** do Telegram, depois da autorização daquela mesma solicitação no site. **Não, cancelar** encerra o pedido antes do envio. A autorização vale cinco minutos.
- Não basta conhecer o token do bot ou a credencial do worker: o mesmo valor e destinatário precisam ter sido autorizados pelo dono no site. A confirmação web fica ligada ao hash imutável do pedido e ao UID do proprietário; a confirmação Telegram exige o ID vinculado e a geração atual do runtime.
- As tarifas do provedor e eventual markup de saque da subconta saem do valor bruto solicitado. O débito é limitado ao valor confirmado. O líquido e as tarifas efetivas são mostrados após consulta autoritativa do saque. Não há cotação antecipada documentada pela API; a interface informa essa limitação antes da autorização.

## Concorrência e falhas

O pedido e a chave Pix ficam cifrados, com uma chave de idempotência permanente por saque, enviada no corpo do POST. Antes de chamar o banco, uma transação marca o saque como em processamento e adquire um bloqueio global da conta PurinCash. Cliques repetidos ou simultâneos não enviam outro POST.

HTTP 202, 409, 429, perda de conexão ou resposta ambígua mantêm o pedido em conferência. A atualização usa `GET /v1/subaccounts/{id}/payouts/saq_idem_<chave>`; nunca repete automaticamente o envio. Valor e subconta retornados devem coincidir com o pedido. Um saque concluído ou uma recusa definitiva libera o bloqueio. Se houver falha bancária sem confirmação de estorno, ele continua em conferência até resolução. Cancelar depois do envio é recusado.

Permissões de navegador não fornecem um endpoint que execute o saque diretamente; ele só pode autorizar a solicitação. A confirmação bancária passa pelo runtime autenticado e pelo proprietário Telegram. O estado desativado, suspensão da conta, revogação do runtime, mudança de vínculo, alteração das taxas e expiração são verificados antes do envio.

Testes de transferência usam exclusivamente o provedor simulado. Testar um saque real exige que a própria dona confirme o envio no Telegram. Não realizar saques, depósitos ou alterações de saldo apenas para validar telas.

Referências: https://docs.purincash.com/guias/subcontas e https://docs.purincash.com/api-reference/subcontas/payout-from-subaccount.
