# Revenda e parceiros Blackout

Estado: central da dona, adesão opcional, permissões e catálogo conectados às rotas HTTP e aos painéis web. Checkout de revenda, carteira de comissões e comandos de revenda no Telegram ainda pendentes; esta etapa não habilita cobranças de revenda.

## Regras confirmadas pela dona

1. Duas modalidades: produtos do fornecedor com estoque central; planos Blackout com preço de revenda definido pelo parceiro.
2. Planos: valor base Blackout preservado; tarifa Purin descontada da margem do parceiro; nenhuma comissão adicional Blackout de 12%.
3. O parceiro participa da primeira contratação e das renovações realizadas pelo parceiro. O vínculo e a política precisam ser registrados na contratação para orientar a renovação.
4. Produtos: o fornecedor precisa autorizar cada produto e cada parceiro. O parceiro não recebe acesso aos códigos ou arquivos do estoque central.

## Entregue nesta camada

- ResaleCatalog: configuração versionada dos preços de planos por parceiro, validação contra os preços base atuais, bloqueio de autorreferência e parceiros suspensos.
- Autorização versionada por fornecedor, parceiro e produto; consulta de catálogo sem acesso à entrega, revogação imediatamente refletida em novas consultas.
- Cálculo em centavos com margem líquida e insuficiência explícita. Se a tarifa exceder a margem, resultado exige revisão e não cria saldo fictício.
- Trilhas de auditoria sem códigos privados. Nenhuma transferência ou cobrança é realizada por essas operações.

## Integração pendente para lançar

- Interface do fornecedor para autorizar parceiros e do parceiro para definir preços; acesso por responsável confirmado no site e Telegram.
- Link público de revenda com preço validado no servidor e preservado durante autenticação.
- Checkout inicial e renovação: registrar parceiro, valor base, preço final e política no pedido antes de gerar Pix; revalidar permissão na criação, preservar direitos adquiridos após pagamento.
- Conferência do pagamento e tarifa efetiva Purin. Registro único de comissão por pagamento confirmado, vinculado à identidade e à geração de credenciais original.
- Transferência contábil à subconta correta com chave de idempotência persistente. Resultado incerto precisa ser reconciliado antes de nova tentativa; comissão só aparece disponível após crédito confirmado.
- Disputas, estornos e saldo bloqueado. Carteira precisa mostrar valor bruto, base, tarifa, margem e estado do repasse.
- Estoque central: reservar atomicamente na loja fornecedora, sem copiar estoque para lojas revendedoras. Pedidos precisam guardar origem, conteúdo cifrado e custo. Cancelamentos e vencimentos devolvem à origem uma única vez.
- Repasse do custo do fornecedor e retenção da parcela devida antes de permitir saque na loja revendedora. Não debitar custo depois que todo o saldo já foi sacado.
- Notificações de entrega e histórico mantêm o contexto da loja em que o comprador comprou. Fornecedor não recebe acesso a outros dados de clientes do parceiro.
- Teste completo com duas lojas separadas, compras simultâneas da última unidade, pagamento duplicado, revogação, renovação e conciliação da carteira.

## Validação

TypeScript aprovado e três testes de domínio aprovados: autorização/isolamento; preços obsoletos e autorreferência; proteção do valor base e insuficiência de margem. Esta base ainda não deve ser anunciada como checkout de afiliados funcional.

## Central da dona e adesão opcional (implementado)

- Página /#/central, protegida por administração e MFA, com vínculo imutável ao UID da dona e à sua loja fornecedora. Não duplica os documentos de estoque.
- A primeira vinculação exige uma conta administradora que seja responsável pela própria loja. Outra conta administradora não pode assumir a central depois do vínculo.
- A dona visualiza o catálogo central, cadastra produtos, consulta/adiciona/remove/embaralha unidades individuais e aprova/revoga participantes e produtos. Os modos infinito/fantasma continuam no editor de estoque da loja que serve de fonte.
- Página /#/revenda para lojistas: adesão explícita e separada a produtos e planos, seguida de aprovação pela dona. Toda loja começa como lojista comum, sem adesão automática.
- Classificação Lojista comum / Revendedor calculada pelas aprovações atuais, independente da assinatura e do acesso à loja. Solicitação pendente não concede permissão.
- Permissões residem em resale_profiles/{accountId}; a autoridade e a fonte central em resale_platform/settings. Rotas derivam a identidade do Firebase; callers não escolhem a loja-alvo nos pedidos de adesão.
- Os preços de planos só podem ser habilitados após aprovação para planos. A consulta de produtos e a cotação de planos revalidam a modalidade; desligar/revogar tem efeito imediato.
- O checkout de revenda, a reserva entre lojas e os repasses de comissões continuam pendentes. A interface informa essa limitação e não oferece links de cobrança antes da integração financeira.

Validação desta etapa: 132 testes aprovados (incluindo domínio e HTTP/MFA). Prévia com dados fictícios: filtro de solicitações, aprovação, adesão a planos sem adesão a produtos e largura de 390px sem overflow horizontal.
