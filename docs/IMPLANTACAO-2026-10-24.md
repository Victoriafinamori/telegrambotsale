# Implantação de 24/10/2026

Frontend: https://blackout-create.web.app

API central: https://blackout-create-api.squareweb.app

## Infraestrutura configurada

- Firebase `blackout-create`, plano Spark, Authentication por e-mail/senha e Firestore Standard `(default)` em `southamerica-east1` (São Paulo).
- Regras Firestore negam acesso direto do cliente. Índice `merchant_accounts`: `activation_pending ASC`, `created_at DESC`, escopo COLLECTION, ativo.
- Política de senha exige 12 a 128 caracteres. Proteção contra enumeração ativa; e-mails em português do Brasil; somente os dois domínios Firebase de produção autorizados.
- API Square Cloud `aab3217b7ebb465193b72abcadac0254`, 512 MB, Node.js 24.22.1. Aplicação separada dos bots dos clientes, no plano existente.
- Runtime: `HOST=0.0.0.0`, `PORT=80`, `PLATFORM_DATABASE=firestore`, `API_AUTH_MODE=bearer`, `APP_ORIGIN=https://blackout-create.web.app`, `FIREBASE_HOSTING=false`.
- `FIRESTORE_PREFER_REST=true`: o transporte gRPC retornava erros/timeouts na hospedagem; o transporte HTTPS/REST do SDK passou nas verificações. Manter TLS e as mesmas permissões.
- `VITE_API_ORIGIN=https://blackout-create-api.squareweb.app` no build do frontend. A origem exata da API está na CSP do Hosting e a API aceita CORS somente do frontend.

## Identidades e segredos

A identidade `blackout-api-runtime@blackout-create.iam.gserviceaccount.com` recebeu somente o papel personalizado `projects/blackout-create/roles/blackoutApiRuntime`, definido em `ops/firebase-runtime-role.json`. Ela pode ler/gravar dados do banco e consultar usuários para validar sessões, sem administrar usuários, configuração do projeto ou faturamento.

A credencial fica somente em `.secrets/firebase-admin.json` na aplicação privada da API, referenciada por `GOOGLE_APPLICATION_CREDENTIALS`. O caminho não é servido pelo Express. `.secrets/` está excluído do Git e do contexto Docker. Não colocar a credencial no ZIP, frontend, documentação ou chat.

`BOT_TOKEN_ENCRYPTION_KEY` e `ADMIN_MFA_ENCRYPTION_KEY` são duas chaves diferentes, geradas e instaladas no ambiente privado. Não substituir essas chaves sem planejar a recifragem dos dados. As cópias locais ficam em `.local/` com acesso restrito à proprietária, ao usuário isolado de execução e ao sistema Windows.

O perfil administrativo Firebase CLI em `.local/cli-config` é separado da identidade de runtime e não foi enviado à hospedagem.

## Verificação e continuidade

- Compilação TypeScript/Vite/servidor aprovada; 19 testes locais passaram antes da implantação.
- API: `/api/health` e `/api/config` retornaram 200, com projeto real, modo bearer e sem emulador. CORS correto retornou 204, origem indevida 403, acesso anônimo a `/api/me` 401 e tentativa de obter a credencial pela Web 404.
- Leitura, transação com escrita/remoção temporária e consulta de usuário foram verificadas com a identidade restrita no projeto real.
- Os 36 testes online passaram: login Firebase, autorização, matrícula/verificação TOTP descartável, bloqueio de reutilização, prova vinculada à sessão, convites de uso único, correspondência de e-mail, aprovação, isolamento entre lojas, suspensão/restauração e revogação de token. Três usuários e 38 registros descartáveis foram removidos ao final.
- Outras 9 verificações reais de confirmação de e-mail e recuperação passaram em conta descartável: e-mail não confirmado é recusado, link de confirmação é aplicado pelo Firebase, redefinição invalida a senha anterior e a nova sessão funciona. A dona também confirmou o recebimento da mensagem real de recuperação; a senha pessoal não foi alterada.
- O e-mail da dona foi confirmado e o papel de administração concedido pelo bootstrap privado. Em 25/10/2026, a matrícula pessoal do autenticador foi confirmada no Firestore pelo campo `enabled_at`, e o painel autenticado abriu com a ação “Adicionar lojista”. Conta ativa, e-mail verificado e papel de administração conferidos novamente, sem consultar a semente do autenticador.
- A tela de matrícula do autenticador gera um QR Code no próprio navegador, com instruções para Google Authenticator e alternativa de chave manual. Atualização compilada, 19 testes locais aprovados e publicada no Hosting. Sessão vencida exige novo login.
- O computador de administração apresentou cerca de 163 segundos de diferença em relação ao horário do servidor. Os testes TOTP usaram o horário do servidor, sem ampliar a janela de aceitação. O aplicativo autenticador pessoal deve usar horário automático correto.
- Os relatórios e o estado detalhado da sessão estão em `.local/firebase-setup/`, ignorado pelo Git.

Publicação do site/API não integra a execução dos bots de clientes, pagamentos ou desligamento por vencimento. Essas funções continuam fora desta etapa.

Referência da hospedagem: https://docs.squarecloud.app/pt-br/articles/getting-started-with-nodejs

## Integração do bot em 25/10/2026

O runtime de produtos digitais foi implementado e a API/site foram atualizados. A suíte tem 28 testes aprovados, incluindo nove cenários de domínio e integração HTTP com transporte Telegram simulado. `/internal/bot/config` retorna 401 sem credencial; health/config, CORS, bloqueio anônimo e privacidade da identidade foram reconferidos após o deploy.

O pacote mínimo do aplicativo de cada lojista foi compilado e sua instalação de dependências validada. Ele contém apenas o runner, cliente Telegram e dotenv fixado, sem Firebase Admin ou chave de servidor. Vínculo de identidade, Stars, estoque cifrado, entrega, revisão/reembolso, lembretes e renovação manual estão documentados em [BOT-TELEGRAM.md](BOT-TELEGRAM.md).

Nenhum bot real foi iniciado por essa atualização. O piloto precisa de conta de lojista, bot fornecido pelo BotFather e aplicativo dedicado. A conta Square Cloud mostrou 1.960 MB alocados dos 2.048 MB existentes, restando 88 MB; faltam 168 MB livres para o aplicativo mínimo de 256 MB. Nenhum outro aplicativo foi parado ou reduzido. Pagamentos reais não foram efetuados nos testes.

## Atualização posterior: experiência completa e processo piloto

Foram acrescentados foto opcional por produto, suporte com nome/telefone/link, avisos com prévia e fila, histórico completo do comprador, estatísticas/compradores e comprovantes Pix/transferência com aprovação ou recusa do lojista. A proprietária escolheu o modo manual após esclarecimento sobre a regra de Stars para digitais; a diferença de compatibilidade está registrada em `COMPROVANTES-E-AVISOS.md`. A suíte passou com 34 testes. Consultas paginadas de inscritos/histórico foram verificadas no Firestore sem criar documentos.

A proprietária liberou memória e foi criado um aplicativo piloto exclusivo de 256 MB na Square Cloud. O processo iniciou, validou o bot e está enviando heartbeat para a API. Foi instalada somente a credencial limitada da loja, sem Firebase Admin ou chave de criptografia. Nenhum outro aplicativo foi alterado pelo assistente.

A loja piloto é interna, sem cobrança real, vinculada à conta já confirmada da dona. O registro usa valor técnico mínimo para satisfazer o schema; a tela identifica explicitamente o piloto sem cobrança. A rota `#/minha-loja` permite operar a própria loja sem mudar o papel de dona; as rotas administrativas continuam exigindo TOTP. A dona confirmou pessoalmente a identidade no Telegram e informou que o `/admin` apareceu. O campo de identidade e o heartbeat foram reconferidos; somente então a loja piloto foi liberada para testar pedidos. Nenhum pagamento real foi executado. Catálogo/atendimento/dados de pagamento de teste e o roteiro humano de compra/entrega ainda precisam ser exercitados.

## Gestão da loja pelo site

A proprietária confirmou que quer os menus anteriores de gestão pelo site, priorizando essa experiência antes de aperfeiçoar o Telegram. A rota `#/gestao` foi implementada e publicada com produtos, fotos opcionais, estoque de códigos/textos, pedidos/comprovantes, aparência, suporte, instruções de pagamento, cupons e avisos. Esses controles usam a mesma loja e a mesma lógica transacional do bot. Os dados da loja não são simulados pelo frontend.

A suíte passou com 37 testes; três cenários novos verificam a integração web/Telegram, a idempotência e o isolamento das rotas. A leitura da configuração, dos pedidos e dos avisos da loja piloto foi conferida no Firestore com identidade restrita, sem escritas, e encontrou o produto existente. As verificações públicas da API/CORS e bloqueio anônimo passaram após a publicação. A revisão visual pelo navegador ficou bloqueada porque o uso local foi desativado nas configurações do Work; não foi substituída por automação alternativa. A skill Impeccable foi usada como referência de adaptação, com detector sem apontamentos nos novos arquivos da interface; manteve-se a identidade visual existente.
