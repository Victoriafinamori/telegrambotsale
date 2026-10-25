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
