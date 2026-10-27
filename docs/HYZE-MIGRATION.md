# Migração preparada para Hyze Cloud

## Estado em 27/10/2026

### Migração iniciada

- Plano Starter confirmado pela API: 1.024 MB e quatro projetos estimados. A conexão privada da Hyze foi validada e novas ativações ficaram pausadas durante a migração.
- Aplicação `Blackout-API` criada com 512 MB, porta 3000 e domínio solicitado `blackout-create-api.hyzecloud.app`. O domínio HTTPS ainda não foi validado.
- O primeiro build falhou: a imagem Node padrão executou Node 22.23.2 e tentou recompilar o pacote já compilado. O pacote corrigido remove scripts de build e dependências de desenvolvimento e fixa Node 24.18.0 pelo npm, com lockfile próprio. O comando é `./node_modules/node/bin/node hyze-start.mjs`.
- A publicação do pacote corrigido ainda está pendente. Nenhuma identidade Firebase ou chave de cifragem foi instalada na Hyze. API e piloto continuam na Square; frontend permanece com a origem anterior.
- Não habilitar novas ativações nem parar o piloto Square antes de validar o pacote corrigido, a API e a transferência coordenada do runtime.

- A criação automática de novos aplicativos na Square foi pausada por escolha da proprietária.
- O provedor da automação agora é a Hyze. A chave Hyze ainda precisa ser conectada; mantenha novas ativações desabilitadas até a migração ser validada.
- A API central e o bot piloto ainda estão na Square. Não foram parados, movidos ou excluídos.
- O frontend permanece no Firebase Hosting; identidade, banco e dados continuam no Firebase.
- Na preparação inicial, a conta Hyze mostrou Free, 256 MB totais e sete dias de teste. Depois a proprietária contratou Starter e autorizou iniciar a migração, conforme atualização acima.

## Artefatos sem credenciais

Após `npm run build`, rode `node --import tsx scripts/package-hyze.ts`. Isso gera uma pasta ignorada `.local/hyze-migration-<timestamp>` com:

- `blackout-api.zip`: compilados, frontend, package.json, lockfile e inicializador Hyze. Nenhuma chave ou variável real é incluída.
- `blackout-bot-template.zip`: somente runner/cliente Telegram e manifesto. A memória do bot é 256 MB. A publicação automática produz o nome real por UUID; o template genérico não deve ser usado para ativar uma loja paga manualmente.
- `private-env.example`: nomes e placeholders das variáveis privadas necessárias.

Não reutilize a ZIP da publicação incremental Square como primeira publicação Hyze: ela não contém os manifestos que a Hyze precisa para instalar dependências.

## Conexão do provedor de bots

Na Hyze, Configurações → Desenvolvedor → Nova chave. Crie uma chave dedicada ao workspace Blackout. A chave pode controlar os recursos do workspace; não é um login CLI.

Na administração Blackout, Hospedagem automática dos bots, cole a chave no campo privado e conecte com a opção de novas ativações desmarcada durante a preparação. O segredo será cifrado em `platform_hosting/hyze`, com contexto `hyze-hosting`. Os jobs novos recebem `provider: hyze`. Jobs da Square não são retomados pelo worker Hyze.

O adaptador valida `/api/plans/current` e `/api/apps/`, publica com `/api/apps/deploy`, instala somente as duas variáveis permitidas do bot em `PUT /api/apps/:id/env` e reinicia apenas o novo aplicativo. Não envia `NODE_ENV`, `PORT` ou outras variáveis reservadas.

## Quando decidir migrar

1. Disponibilize capacidade e slots: API de 512 MB mais piloto de 256 MB exigem pelo menos 768 MB e dois aplicativos. Cada nova loja precisa de mais 256 MB e um slot. Contratação/renovação do plano é feita pela proprietária.
2. Confirme Node 24 ou superior no destino. O pacote declara `engines.node >=24.12.0` e o inicializador recusa Node anterior a 24. Não considere o runtime validado apenas porque o painel oferece “Node”.
3. Crie a API com o pacote completo, comando `./node_modules/node/bin/node hyze-start.mjs`, porta pública 3000, memória 512 MB e host HTTPS real. Não altere a origem publicada no frontend antes dos testes.
4. Instale as variáveis privadas pelo ambiente da Hyze. Em `BLACKOUT_FIREBASE_ADMIN_JSON`, use somente a identidade Firebase Admin dedicada ao runtime do projeto, nunca credenciais CLI/Google pessoais. O inicializador confere o projeto e grava um arquivo privado no ambiente do servidor. Preserve exatamente as duas chaves de cifragem atuais, distintas entre si: trocá-las impede abrir os tokens, pagamentos e MFA existentes.
5. Verifique `/api/health`, `/api/config`, Firebase Auth e leitura/gravação real autenticada no Firestore. O endpoint health sozinho não comprova acesso ao banco.
6. Preserve callbacks antigos enquanto houver cobranças emitidas com a origem Square. As integrações e gerações de credenciais de pagamentos não devem ser apagadas ou recriadas para migrar a hospedagem. Valide o destino de cada webhook antes de desligar a API antiga.
7. Compile/publice o frontend com `VITE_API_ORIGIN` da Hyze somente depois de validar a nova API. Confira CORS e sessões. Atualize a origem de geração de links/callbacks da API; mantenha compatibilidade com cobranças pendentes.
8. Migre o piloto em janela controlada. Telegram long polling não permite dois workers do mesmo token ao mesmo tempo. Pare o worker antigo antes de iniciar o novo, preserve os dados/offsets e atualize o vínculo do runtime de forma explícita, sem reiniciar a assinatura. A automação de novas contas não deve ser usada para migrar contas ativas.
9. Valide `/start`, painel, confirmação do responsável, catálogo, pedidos, entrega e carteira. Depois habilite novas ativações Hyze e faça uma contratação nova completa.
10. Só encerre os aplicativos Square depois de confirmar a operação e esvaziar a necessidade dos callbacks antigos. Até então, o rollback é restaurar a origem anterior e usar o runtime antigo de forma coordenada.

Na preparação inicial não houve contratação ou publicação. Na fase atual, a proprietária contratou o plano e a aplicação foi criada, mas a migração ainda não foi concluída, conforme estado acima.

## Referências oficiais consultadas

- https://github.com/Hyze-Cloud/hyzecloud-sdk-ts/blob/main/src/resources/apps.ts
- https://github.com/Hyze-Cloud/hyzecloud-sdk-ts/blob/main/src/types.ts
- https://github.com/Hyze-Cloud/hyzecloud-docs/blob/main/pt/concepts/secrets-and-env.mdx
