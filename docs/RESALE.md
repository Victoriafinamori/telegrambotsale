# Revenda e parceiros Blackout

## Regras

- A adesão é opcional e separada para produtos e planos. A dona aprova cada modalidade; lojistas comuns continuam vendendo seus próprios produtos.
- Produtos globais: a Blackout recebe somente o custo autorizado do fornecedor. A tarifa Purin sai da margem do revendedor, sem comissão adicional de 12%.
- Planos: preserva-se o preço base Blackout; a diferença, descontada a tarifa Purin, pertence ao parceiro. Sem comissão adicional de 12%. O vínculo contempla contratação inicial e renovações pelo parceiro.

## Operação

A página `/#/central` exige administração, MFA e o UID vinculado da dona. Ela administra o estoque fonte, os participantes e a autorização individual de produtos. O revendedor não consulta códigos ou arquivos centrais.

Em `/#/revenda`, o parceiro aprovado publica os produtos autorizados com seu preço e configura os três preços de planos. O link `/#/comprar?partner=ID` conserva a indicação durante o login. Valores e permissões são revalidados no servidor; cada pedido congela custo, preço, destinatário e geração da conexão Purin.

O checkout de produtos reserva atomicamente na origem e cifra a entrega para a loja revendedora. Cancelamento ou vencimento devolve as unidades uma única vez. Compras simultâneas não podem vender a mesma última unidade. Os modos individual, infinito e fantasma usam o estoque fonte.

O Pix utiliza `subaccountId` e `subaccountFeeCents`: o provedor retém o custo/base na conta principal e credita a margem líquida diretamente na subconta. Não existe uma segunda transferência após a venda. A entrega/ativação depende do pagamento consultado no provedor e da confirmação do crédito no extrato correto. Se o custo não for integralmente preservado, a operação exige revisão; não é criado saldo fictício.

Cada pagamento gera um registro idempotente em `resale_commissions` e no histórico privado do parceiro. A carteira diferencia custo do fornecedor/base Blackout da comissão das vendas comuns. O saldo sacável, os bloqueios e os saques continuam sendo consultados na Purin.

Uma rotina persistente de reconciliação consulta até cinco operações por minuto, com paginação para evitar que operações antigas impeçam novas conferências. Ela consulta cobranças existentes; não cria um novo Pix para resolver uma resposta incerta.

## Limites e validação

- Produtos compartilhados exigem Pix Purin e carrinho separado dos produtos próprios. Cupons não se aplicam ao estoque compartilhado nesta versão.
- Revogação bloqueia novas vendas; pedidos já criados conservam os valores e destinatários originais. Uma renovação sem parceiro elegível volta ao preço direto Blackout.
- O histórico de comissão demonstra o crédito original. Disputas e estornos posteriores podem afetar o saldo real do provedor; não representam disponibilidade garantida para saque.
- Ainda é necessário um teste de produção com uma segunda loja aprovada e um pagamento real, incluindo a conciliação nas duas contas. Não foram movimentados valores reais nos testes automatizados.

Validação: 137 testes automatizados aprovados, incluindo contratação/renovação afiliada, crédito confirmado versus pendente, isolamento, última unidade concorrente, entrega cifrada e restauração idempotente do estoque. Compilação e publicação devem ser registradas separadamente da implementação.
