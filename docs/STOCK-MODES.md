# Modos de estoque

Disponíveis por produto no site (Minha loja → Estoque) e Telegram (/admin → Estoque → Modo de estoque).

- Individual: consome códigos ou arquivos exclusivos na ordem salva.
- Fantasma: quantidade disponível de 0 a 1.000.000 e entrega repetida. Cada unidade reservada desconta 1; cancelamento, recusa e vencimento devolvem a reserva.
- Infinito: repete o conteúdo sem consumir unidades. Selecione Individual ou Fantasma para desativar.

Os códigos individuais são preservados ao trocar de modo. A entrega repetida é uma cópia cifrada independente da unidade de origem. Pedidos guardam seu próprio conteúdo e modo de reserva. Pedidos ainda reservados bloqueiam mudanças no modo para impedir divergências no saldo.

O site permite escrever uma mensagem, manter a entrega atual ou repetir uma unidade salva. No Telegram também é possível enviar diretamente um arquivo. O assistente exige confirmação e cifra o rascunho. Os controles são restritos ao responsável e verificam a revisão do estoque.

A simulação reproduz os modos com conteúdo fictício. A interface usa cartões por produto e seção recolhível de unidades individuais.

Validação: suíte completa com 124 testes aprovada; após incluir o cenário de arquivo repetido, os 67 testes de bot e simulação passaram novamente. Testes de interface feitos com dados fictícios; nenhum estoque real foi alterado para testar.
