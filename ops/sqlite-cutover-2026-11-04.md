# Migração em produção — 04/11/2026

## Estado atual

A Blackout-API na Hyze usa SQLite central cifrado. A manutenção foi retirada e os
três workers estão em execução: piloto `@blackoutshopbrbot`, ICIA `@ICIALOJINHAbot`
e TS STORE `@dgdigitalstorebot`. O BRIQNEX e os recursos contratados não foram alterados.
Firebase continua no login e Hosting; o Firestore antigo é uma origem arquivada.

## Recuperação e preservação

- Ensaio completo: 1.601 documentos, 53 coleções, backup reaberto e validado.
- Com autorização explícita da dona, os três workers foram parados e a API foi
  mantida em manutenção para a exportação final. Os digests de ensaio e final
  coincidiram; a origem ficou sem alterações durante a cópia.
- Todos os tokens, responsáveis, contratos, MFA, vínculos financeiros, filas,
  pedidos e offsets foram preservados. Foi possível recuperar o catálogo global
  com seus 32 produtos; não foi necessário usar a permissão de refazer o estoque.
- Validação de abertura dos três tokens, do segredo MFA, de 26 unidades individuais
  e de 16 templates de estoque. Esses números não contam quantidades virtuais.
- Consultas somente GET à Purin confirmaram subcontas ativas e vínculos exclusivos.
  Piloto: 12%; ICIA: 0%; TS STORE: 2% nos produtos próprios. R$ 1 por saque.
  A identificação externa legada `DG STORE` da TS STORE permaneceu preservada.
- As regras de revenda global continuam com valor fixo do fornecedor, sem comissão
  adicional sobre esses produtos, conforme a implementação existente.

## Instalação e validação

Deployment da API: `bf5d871d-4ab7-4c47-8851-ae00c8859f44`.

O banco cifrado foi instalado, com autorização, em `.blackout-data/central.sqlite`
no armazenamento privado do mesmo aplicativo. A chave de armazenamento é exclusiva;
as chaves antigas de token e MFA não foram substituídas. Um arquivo privado de
transporte foi usado uma única vez; não deve ser reutilizado para novos deploys.

A inicialização recusa banco vazio ou não verificado. A API abriu o banco com sucesso,
e o caminho do arquivo retorna 404 pela origem pública. Após a instalação e antes de
liberar gravações, foi criado um backup Hyze, baixado e restaurado localmente: todos
os 1.601 documentos conferiram com o manifesto.

Os três workers autenticaram na API SQLite com suas credenciais anteriores. Seus
heartbeats foram observados no backup do banco já em operação. O offset novo do
piloto avançou enquanto o offset original do Firestore ficou congelado, confirmando
que os novos comandos usam a base SQLite.

Teste real pelo Telegram Web da dona: `/start`, `/admin` e `Meu estoque global`.
A tela mostrou 32 produtos, 6 categorias e a reposição prioritária. O primeiro envio
de `/admin` teve resultado incerto no Telegram e não foi repetido automaticamente;
uma nova solicitação da administração respondeu. Não foram alteradas as proteções
contra repetição de entrega ou pagamento. Evidência: `.local/sqlite-global-stock-live.png`.

Nenhum Pix, compra, saque ou transferência foi criado neste procedimento. As duas
cobranças antigas excluídas pela dona não foram reconciliadas manualmente. Uma nova
compra real com pagamento pelo usuário ainda precisa ser testada após a migração.

## Configuração privada

- `BLACKOUT_DATABASE_BACKEND=sqlite`
- `BLACKOUT_SQLITE_PATH=.blackout-data/central.sqlite`
- `BLACKOUT_SQLITE_ENCRYPTION_KEY`: chave exclusiva no ambiente privado
- `SQLITE_DURABLE_STORAGE_CONFIRMED=true`
- `BLACKOUT_MAINTENANCE=false`

Os valores de credenciais não entram no Git. Os relatórios privados de ensaio,
exportação final, verificação dos vínculos, restauração e estado dos workers ficam
em `.local/deployment-private/`.

## Limites e próximas etapas

O estoque e as configurações ainda pertencem ao banco SQLite **central**. O modo
opcional de navegação/rascunhos por bot está preparado, mas desativado. Não descrever
esta instalação como SQLite independente por lojista nem API restrita a pagamentos.
A migração completa de dados próprios para cada worker permanece uma etapa separada.

O backup consistente da virada foi comprovado e copiado para fora do disco da Hyze.
Isso não habilita sozinho backups recorrentes consistentes de um SQLite com escritas
ativas. Configurar a rotina separadamente; para cópia manual, interromper escritores
ou produzir uma cópia com a API de backup do SQLite antes de arquivar.

Após novas gravações, nunca simplesmente religar a API antiga com Firestore ou
instalar novamente o banco da exportação inicial. É necessário congelar o SQLite e
reconciliar pedidos, estoque, pagamentos e offsets antes de qualquer rollback.
