# Estoque global pelo Telegram — execução em 03/11/2026

## Implementado e validado

- Dona vinculada ao fornecedor: `/admin` → `Meu estoque global`.
- Categorias e páginas de oito itens; itens sem estoque ou com até cinco unidades
  aparecem primeiro em `Repor primeiro`. Estoque infinito não gera alerta de falta.
- Reposição usa os controles existentes e o mesmo documento central do produto;
  não cria uma cópia para cada revendedor. Combos continuam apontando aos componentes.
- Revendedores recebem `Produtos do fornecedor`; acesso direto à tela da fornecedora
  é recusado. Compradores não recebem controles administrativos.
- Teste integrado em SQLite confirmou que a dona repõe o estoque existente e que
  comprador e revendedor não conseguem acessar a administração global.
- Suíte completa: 208 testes aprovados. Build de frontend e servidor aprovado.

## Recuperação da origem

A leitura pontual do Firebase respondeu 200 durante a execução, mas a exportação
voltou a encontrar quota excedida antes de recuperar o catálogo. O ensaio incompleto
contém apenas 41 registros de autenticação e limites; nenhum estoque recuperado.
Ele não possui marcador de migração final e não pode substituir a base de produção.
Não foi encontrada uma cópia completa de estoque nos 19 arquivos JSON locais de
estado/revisão inspecionados. Essa busca não comprova ausência de backups em outros lugares.

O exportador foi alterado para salvar primeiro as raízes operacionais (catálogo,
contas, tokens cifrados, hospedagem e pagamentos), antes dos históricos antigos.
Mantém descendentes com pais ausentes, usa lotes menores e limita a espera por leitura.
Uma falha gera diagnóstico privado ao lado do destino, sem expor credenciais no console.

## Publicação e limites

O código foi enviado à API Hyze na atualização `e7d13f5e`, mantendo a manutenção.
O teste com marcador vazio de arquivo confirmou persistência após reinício.
O mesmo marcador permaneceu na aba Arquivos após a atualização concluída, confirmando
também persistência nesse redeploy. Evidência local: `.local/hyze-persistence-global-stock.png`.
Isso testa a sobrevivência de arquivo no aplicativo, não garante recuperação de um
host perdido nem substitui backup SQLite consistente e cópia fora desse disco.

Não foram apagados dados da origem, criadas cobranças, realizados saques nem trocadas
as chaves existentes. A API ainda usa Firestore em manutenção. Nenhum banco vazio foi
ativado e nenhum estoque foi anunciado como migrado. O próximo passo depende de
recuperar dados reais ou de um recadastro explicitamente conferido das duas lojas e
dos vínculos financeiros. A prioridade de liberação segue `retomada-da-migracao.md`.
