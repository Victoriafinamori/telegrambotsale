# Migração para Hyze Cloud

## Estado em 27/10/2026

### Migração concluída

- Plano Starter confirmado pela API: 1.024 MB e quatro projetos estimados. API e piloto reservam 768 MB; restam 256 MB para mais um bot. A conexão privada está validada e as novas ativações foram habilitadas após a troca.
- API Hyze `d4da3202-673c-4985-98b1-c126468f39b5` publicada com 512 MB e porta 3000. HTTPS validado em `https://blackout-create-api.hyzecloud.app`: health/config 200 e configuração autenticada do piloto 200, incluindo leitura Firestore e escrita do limitador persistido.
- O primeiro build falhou: a imagem Node padrão executou Node 22.23.2 e tentou recompilar o pacote já compilado. O pacote corrigido remove scripts de build e dependências de desenvolvimento e fixa Node 24.18.0 pelo npm, com lockfile próprio. O comando é `./node_modules/node/bin/node hyze-start.mjs`.
- A proprietária autorizou explicitamente a identidade Firebase Admin dedicada e as duas chaves de cifragem no ambiente privado da API Hyze. Os valores existentes foram preservados e instalados sem incluir segredos em ZIP, Git ou frontend.
- Frontend publicado no Firebase Hosting com origem Hyze e CSP correspondente; bundle `index-C_EYury9.js`.
- Worker piloto Hyze `56f6b1ca-cf09-42ed-9379-d401d810eadd` executando com 256 MB e heartbeat recente. A proprietária autorizou a credencial privada de execução no destino. O worker Square foi parado antes da configuração Hyze; a API Square confirmou `CONTAINER_ALREADY_STOPPED` mesmo enquanto o endpoint de status ainda mostrava informação antiga.
- Vínculo do piloto migrado em transação, preservando segredo, geração, offset, estoque, responsável e pedidos. Assinatura preservada de 25/10/2026 até 25/11/2026. Não foi usado o provisionamento de nova conta, que zeraria o offset.
- A proprietária confirmou explicitamente parar a API antiga após ser informada sobre links/callbacks anteriores. A parada foi enviada; o health antigo retornou HTTP 408, e a API Hyze continuou 200. Os dois aplicativos Square foram preservados para rollback, sem exclusão.
- Painel autenticado abriu na API Hyze. Saúde final: uma loja online, zero desconectadas, zero alertas, pagamentos pendentes, entregas com problema ou ativações pendentes. Hyze conectada e habilitada.
- Conferência de pagamentos: nenhuma fatura de assinatura registrada; piloto com um pedido expirado e um cancelado, nenhum aguardando pagamento ainda válido. Não houve cobrança ou saque de teste nesta migração.
- Verificação de tipos, compilação e suíte completa: 116 testes aprovados.

- A criação automática de novos aplicativos na Square foi pausada por escolha da proprietária.
- O provedor das novas ativações é a Hyze, com chave conectada e automação habilitada. Sem os 256 MB necessários para o próximo bot, a ativação deve permanecer pendente sem iniciar o período contratado.
- O frontend permanece no Firebase Hosting; identidade, banco e dados continuam no Firebase.
- Na preparação inicial, a conta Hyze mostrou Free, 256 MB totais e sete dias de teste. Depois a proprietária contratou Starter e autorizou iniciar a migração, conforme atualização acima.

## Artefatos sem credenciais

Após `npm run build`, rode `node --import tsx scripts/package-hyze.ts`. Isso gera uma pasta ignorada `.local/hyze-migration-<timestamp>` com:

- `blackout-api.zip`: compilados, frontend, package.json, lockfile e inicializador Hyze. Nenhuma chave ou variável real é incluída.
- `blackout-bot-template.zip`: somente runner/cliente Telegram e manifesto. A memória do bot é 256 MB. A publicação automática produz o nome real por UUID; o template genérico não deve ser usado para ativar uma loja paga manualmente.
- `private-env.example`: nomes e placeholders das variáveis privadas necessárias.

Não reutilize a ZIP da publicação incremental Square como primeira publicação Hyze: ela não contém os manifestos que a Hyze precisa para instalar dependências.

A Hyze exige readiness HTTP em `/health` para a API e também em `/` para o worker. Antes da configuração privada, os inicializadores respondem nessas rotas técnicas com `ok: false` e estado de preparação, sem acessar Firebase ou Telegram; `/api/health` continua 503. Isso permite concluir o primeiro deploy, necessário para a API de variáveis encontrar o diretório da aplicação. A configuração privada seguida de reinício inicia o serviço real. Somente health real, autenticação no banco e heartbeat do bot comprovam operação.

`PLATFORM_DATABASE` é reservado na Hyze; o inicializador define Firestore internamente. O pacote da API usa um manifesto de produção sem scripts de build, e os bots incluem Node 24.18.0 fixado e um inicializador que chama explicitamente `runBot()` após receber as duas variáveis privadas.

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

Não houve uma contratação real adicional nem pagamento/saque para testar a automação nesta migração. Os testes de compra e isolamento passaram na suíte, mas o próximo cadastro pago ainda deve ser acompanhado de ponta a ponta.

## Rollback coordenado

Os aplicativos Square antigos continuam salvos: API `aab3217b7ebb465193b72abcadac0254` e worker `db02dc1f31e343e8bbd5038105a68753`. Antes de religar o worker Square, pare o piloto Hyze e restaure os vínculos `bot_runtimes`, `merchant_bot_setup`, `bot_runtime_apps` e `square_app_links`, preservando offset e datas atuais. Nunca execute os dois workers simultaneamente. Para restaurar a API antiga, pause ativações, religue sua aplicação e republique o frontend com a origem Square e CSP correspondentes. Não troque chaves de cifragem ou credenciais dos pagamentos.

## Referências oficiais consultadas

- https://github.com/Hyze-Cloud/hyzecloud-sdk-ts/blob/main/src/resources/apps.ts
- https://github.com/Hyze-Cloud/hyzecloud-sdk-ts/blob/main/src/types.ts
- https://github.com/Hyze-Cloud/hyzecloud-docs/blob/main/pt/concepts/secrets-and-env.mdx
