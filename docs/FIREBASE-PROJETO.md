# Projeto Firebase registrado

A configuração pública recebida corresponde ao projeto **blackout-create**, domínio de autenticação `blackout-create.firebaseapp.com` e aplicativo Web `1:1012322126201:web:2ce5fc5d7c863ae24587a8`. Ela está centralizada em `config/firebase.web.json`; `.firebaserc` seleciona o mesmo projeto para comandos administrativos explícitos.

O servidor fornece ao navegador apenas apiKey, authDomain, projectId e appId por `/api/config`. O cliente inicializa Firebase Authentication com esses dados. O código do Analytics mostrado no exemplo do console não faz parte da inicialização da aplicação. Configuração pública não concede permissão administrativa no Firebase ou na Blackout Create.

## Execução real e testes

`npm start` usa a configuração registrada, salvo substituições explícitas por variáveis de ambiente. Para usar outro projeto, também é obrigatório fornecer sua API key e authDomain; dados do projeto Blackout Create não são herdados por um projeto diferente.

`npm run local`, `npm run emulators` e `npm run test:emulator` selecionam explicitamente `demo-blackout-create`. A aplicação recusa emulador com um ID de projeto real e não herda o appId real nos testes. Use esses comandos para testes; a seleção padrão do CLI é o projeto real.

## Verificação nesta etapa

- Compilação e testes locais da configuração, da API e das permissões passaram.
- Os artefatos compilados do servidor incluem o JSON público necessário ao runtime.
- A consulta somente de leitura ao endpoint público do Firebase Authentication foi bloqueada pela rede do ambiente: `CONNECT tunnel failed, response 403`. Isso não permite concluir se os provedores e domínios estão corretamente habilitados no projeto remoto.
- O perfil Firebase CLI desta aplicação ainda não possui conta Google autorizada. A configuração pública não substitui essa autorização.

## Para concluir a conexão online

1. Manter Spark. Validar Authentication/Firestore/Hosting, suporte HTTP/HTTPS da Square Cloud e os domínios autorizados. A base central agora tem adaptador Firestore; não exige PostgreSQL em produção. Siga `PUBLICAR-FIREBASE-SPARK.md`.
2. Autorizar o Firebase Admin no projeto `blackout-create`. Em infraestrutura Google, preferir identidade do serviço com permissões mínimas. Em outro provedor, usar federação de identidade quando disponível ou um segredo de servidor protegido. Senhas Google, tokens de login e chaves privadas não devem ser enviados no chat ou incluídos no frontend.
3. Criar/conferir Firestore padrão, publicar regras/índices e conceder o acesso inicial do dono pelo comando privado `admin:grant` após confirmação do e-mail. O adaptador PostgreSQL legado ainda usa suas migrações SQL.
4. Configurar `ADMIN_MFA_ENCRYPTION_KEY` privada no servidor. O segundo fator TOTP independente já foi implementado com matrícula na tela, bloqueio de repetição e reset privado. Validar a configuração no ambiente real antes da operação.
5. Validar uma sessão completa no projeto real: autenticação, confirmação de e-mail, cookie HTTPS, permissões, saída e revogação. Os testes do emulador não substituem essa validação.

Ainda não há publicação da aplicação nem conexão real com Telegram nesta etapa. O assistente já recebe o token por formulário autenticado e o cifra no servidor; a execução do bot ainda não está integrada.
