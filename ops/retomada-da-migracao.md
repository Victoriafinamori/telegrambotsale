# Retomada da migração Blackout

## Situação desta preparação

- Código e testes preparados; esta etapa não altera a produção nem desliga a manutenção.
- Firebase continua responsável por login e Hosting, sem ativar faturamento.
- O banco central SQLite poderá atender carteira, pagamentos e estoque global após a cópia validada.
- O piloto tem navegação e rascunhos de personalização locais, desativados por padrão.
- Estoque próprio, criação de produtos e demais rotinas ainda usam o serviço central.
  Não remover essas funções do painel antes de completar e validar os equivalentes no bot.

## Prioridade de liberação dos bots

1. Recuperar estoque e vínculos reais; não exigir recadastro item a item se a origem voltar.
2. Instalar o banco central SQLite validado para retirar pagamentos e estoque global
   da dependência do Firestore. Os workers atuais podem usar essa central antes da
   migração completa dos estoques próprios para cada bot.
3. No bot da fornecedora confirmada: `/admin` → `Meu estoque global`. A tela usa o
   catálogo já vinculado a `resale_platform/settings`, com categorias, paginação e
   reposição prioritária para itens sem estoque ou com até cinco unidades.
4. Revendedores usam `Produtos do fornecedor`; a administração global não é exibida
   a eles e callbacks forjados são recusados. Compradores não recebem esses controles.
5. Confirmar reserva e entrega, cancelamento, margem e carteira antes de liberar as lojas.
   A separação completa por worker e o painel do site ficam para a etapa seguinte.

O exportador agora prioriza documentos principais de catálogo, contas, tokens cifrados,
vínculos e pagamentos antes de históricos de autenticação/limites. Descendentes de pais
ausentes continuam preservados; leituras bloqueadas têm tempo limitado. Uma exportação
interrompida permanece **incompleta e não verificada**, nunca pronta para produção.

## Quando as leituras do Firebase voltarem

1. Confirmar a leitura com a identidade administrativa já autorizada, sem habilitar cobrança.
   Se continuar bloqueada por quota, parar aqui: não iniciar um banco vazio.
2. Confirmar armazenamento persistente da Hyze com teste de reinício e redeploy;
   definir backup privado fora do disco da aplicação e testar a restauração.
3. Preparar no ambiente privado a identidade de exportação, `FIREBASE_PROJECT_ID`
   e uma nova `PLATFORM_SQLITE_ENCRYPTION_KEY`, exclusiva para armazenamento.
   Preservar as chaves atuais de tokens e MFA; não enviar valores ao chat/Git.
4. Fazer um ensaio em um arquivo NOVO:

   ```powershell
   npm run migration:export -- .local/migracao-ensaio/central.sqlite
   npm run migration:verify -- .local/migracao-ensaio/central.sqlite --rehearsal
   npm run migration:verify -- .local/migracao-ensaio/central.sqlite.verified-backup --rehearsal
   ```

   O exportador não sobrescreve o destino. Confira contagens, datas e vínculos.
   Nenhum desses comandos confirma pagamentos, emite Pix ou faz saques.
5. Para a exportação FINAL, manter a API em manutenção e parar todos os outros
   escritores da origem: workers, tarefas e scripts administrativos. Só depois executar:

   ```powershell
   npm run migration:export -- .local/migracao-final/central.sqlite --source-quiesced
   npm run migration:verify -- .local/migracao-final/central.sqlite
   npm run migration:verify -- .local/migracao-final/central.sqlite.verified-backup
   ```

   `--source-quiesced` registra a declaração do operador; não para os serviços sozinho.
   O ensaio nunca é marcado como pronto para produção. Arquivar cópia cifrada e chave
   em locais privados separados. As verificações acima exigem o arquivo importado
   ainda sem novas alterações de produção.
6. Transferir o arquivo final para o volume persistente da API e configurar, privadamente:
   `BLACKOUT_DATABASE_BACKEND=sqlite`, `BLACKOUT_SQLITE_PATH`,
   `BLACKOUT_SQLITE_ENCRYPTION_KEY` e `SQLITE_DURABLE_STORAGE_CONFIRMED=true`.
   Na Hyze, não cadastrar nomes `PLATFORM_*`, que são reservados pela hospedagem.
7. Publicar a API compilada com **um único processo**, preservar todas as identidades,
   chaves existentes e origem HTTPS. Liberar manutenção somente após conferir a cópia
   instalada. Testar login/MFA, carteira, compra/cancelamento global e deduplicação.
   Rever pagamentos pendentes sem gerar outra cobrança para substituir uma incerta.
   Não reconciliar as duas cobranças antigas excluídas pela dona.
8. Habilitar separadamente o piloto local, seguindo `telegram-local-migration.md`.
   Preservar offset, responsável e apenas um worker ativo. Medir tempo e chamadas
   antes de estender aos clientes; os testes locais não comprovam velocidade real.

## Preparar os artefatos

```powershell
$env:VITE_API_ORIGIN='https://blackout-create-api.hyzecloud.app'
npm run build
npm test
npm run bot:package
```

O pacote do bot usa uma lista explícita de arquivos e dependências. Não contém
credenciais nem dados de clientes. A preparação da API continua em `scripts/package-hyze.ts`.
Mantenha arquivos de banco, backup e credenciais em `.local/`, fora do Git e de qualquer
pasta pública. ZIP de código não deve carregar esses arquivos privados.

## Se houver falha

Antes de novas escritas no SQLite, manter a origem congelada e corrigir a cópia.
Depois de novas escritas, não religar simplesmente a versão Firestore: interromper
os escritores e reconciliar estoque, pedidos, pagamentos e offsets para evitar
dupla venda, entrega ou repasse. Não há migração/rollback automático nesta etapa.
