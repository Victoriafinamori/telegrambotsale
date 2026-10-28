# Pix automático Blackout (PurinCash)

Uma conta principal Blackout e uma subconta PurinCash por lojista. A subconta é uma atribuição contábil dentro da carteira principal, não uma conta bancária independente. Repasses e verificação documental continuam no painel PurinCash.

## Conectar

1. No painel PurinCash, crie uma chave **produção** com somente **Criar cobranças**, **Consultar cobranças** e **Gerenciar subcontas**. Não habilite saques. A PurinCash agrupa consulta e gestão de subcontas na mesma permissão; a aplicação usa apenas consultas e não implementa transferências, saques ou alteração de taxas.
2. No painel administrativo Blackout, com segundo fator confirmado, preencha a API Key e o **Webhook Secret da conta**. São validados por consultas sem movimentação financeira e salvos cifrados no Firestore privado. Não colocar credenciais no Git, frontend ou runtime do bot.
3. Crie manualmente a subconta na PurinCash. Use o UUID do lojista (mostrado no painel Blackout) como `externalId`, quando o painel permitir. Selecione o lojista na Blackout e informe o `sacc_…`. A API confere a subconta e impede uso por dois lojistas.
4. O lojista escolhe **Pix automático · Blackout** em Pagamentos e salva. Pode solicitar a ativação antes do vínculo. O vínculo administrativo não altera sozinho a forma de pagamento da loja.

Nenhuma URL global precisa ser alterada: cada cobrança recebe `callbackUrl` HTTPS da API, com a versão imutável da conexão. Não regenerar o secret da conta sem atualizar a conexão; a PurinCash deixa de assinar com o antigo imediatamente.

## Cobrança e entrega

- A API calcula o valor a partir do pedido reservado. Usa `/v1/charges`, BRL e uma subconta obrigatória. Novos vínculos configuram **12% de comissão sobre o líquido após a tarifa Purin**, sem componente fixo por venda; **R$ 1,00 de comissão por saque**, sem percentual no saque. Não envia `subaccountFeeCents`: a Purin aplica o markup da subconta. Tarifas Purin são adicionais. Alterações não recalculam lançamentos anteriores. O mínimo do provedor é R$ 0,80.
- QR e copia e cola são exibidos no checkout privado aberto pelo Telegram, sem exigir CPF/e-mail do comprador para PurinCash. O QR é renderizado localmente a partir do BR Code; URLs de imagem fornecidas pelo provedor nunca são acessadas.
- Checkout usa capacidade aleatória no fragmento da URL; somente o bot do comprador recebe o link. O servidor seleciona o provedor pelo pedido, sem aceitar recebedor ou valor do navegador.
- HMAC-SHA256 é validado sobre os bytes originais antes do JSON. `charge.paid` exige ID coerente, consulta autenticada da cobrança, valor, moeda, metadata, identificação externa e subconta congelada. Somente chaves `ps_live_` são aceitas; sandbox explícito é rejeitado. Pedidos encerrados/suspensos/vencidos vão para atendimento/reembolso, sem entrega.
- Pedido, estatísticas e efeitos de entrega são gravados atomicamente. Repetições não duplicam estoque ou entrega. O worker do bot envia efeitos persistidos com leases/acks; se não houver interação no bot, a manutenção os busca em até cerca de 45 segundos. Reembolso bloqueia entregas ainda não enviadas.
- A API PurinCash não documenta idempotência para criação de cobranças. A consulta prévia da subconta ocorre antes de registrar uma tentativa de criação. Um bloqueio transacional permite **um POST ativo por pedido**. Recusas definitivas HTTP 400/401/403/404/422 permitem tentar novamente depois de corrigir a causa; falhas ambíguas de rede ou servidor nunca fazem um segundo POST automático. Uma nova consulta tenta localizar a cobrança entre as 100 mais recentes da subconta por `customer.externalId` exclusivo. Se não encontrar, requer atendimento. Não gerar outro pedido para contornar uma cobrança incerta.
- A chave pode estar válida para consultar a API e a conta ainda estar impedida de receber. Na recusa HTTP 403 que exige **Carteira → Verificar Chave PIX**, o checkout mostra essa pendência, mantém a tentativa como rejeitada e continua oferecendo Verificar confirmação mesmo sem QR. Essa exigência vem da PurinCash. O painel atual pode mostrar apenas verificação de documento/selfie; se o cadastro solicitado pela API não estiver disponível, a PurinCash precisa resolver a divergência. Não tentar saques ou alterar dados por endpoints não documentados para contornar o bloqueio.
- Se a resposta original de criação for perdida, o GET pode não retornar o QR; a confirmação continua conciliável, mas não prometemos reconstrução do código. Conferir a cobrança na PurinCash, aguardar expiração e atender o comprador antes de uma nova compra.
- Rotação mantém versões privadas anteriores para pedidos pendentes. Vincule novamente as lojas à conexão atual após conferir que a chave pertence à mesma conta. IDs de subcontas já usados permanecem reservados ao lojista original.

A carteira e os saques das subcontas têm fluxo próprio, descrito em WALLET.md. Gestão de contestações/MED permanece no provedor. A política de comissão está em `BLACKOUT_PURIN_FEES`, no servidor.

Documentação: https://docs.purincash.com/guias/subcontas e https://docs.purincash.com/webhooks/assinatura.
