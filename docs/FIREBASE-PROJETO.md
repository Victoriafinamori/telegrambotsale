# Projeto Firebase registrado

A configuração pública recebida corresponde ao projeto **blackout-create**, domínio de autenticação `blackout-create.firebaseapp.com` e aplicativo Web `1:1012322126201:web:2ce5fc5d7c863ae24587a8`. Ela está centralizada em `config/firebase.web.json`; `.firebaserc` seleciona o mesmo projeto para comandos administrativos explícitos.

O servidor fornece ao navegador apenas apiKey, authDomain, projectId e appId por `/api/config`. O cliente inicializa Firebase Authentication com esses dados. O código do Analytics mostrado no exemplo do console não faz parte da inicialização da aplicação. Configuração pública não concede permissão administrativa no Firebase ou na Blackout Create.

## Execução real e testes

`npm start` usa a configuração registrada, salvo substituições explícitas por variáveis de ambiente. Para usar outro projeto, também é obrigatório fornecer sua API key e authDomain; dados do projeto Blackout Create não são herdados por um projeto diferente.

`npm run local`, `npm run emulators` e `npm run test:emulator` selecionam explicitamente `demo-blackout-create`. A aplicação recusa emulador com um ID de projeto real e não herda o appId real nos testes. Use esses comandos para testes; a seleção padrão do CLI é o projeto real.

## Estado online em 25/10/2026

O frontend foi publicado em `https://blackout-create.web.app` e a API central em `https://blackout-create-api.squareweb.app`. O Firebase permanece no plano Spark, com regras privadas, índice ativo e banco padrão em São Paulo. A API usa uma identidade dedicada com sete permissões de dados/consulta de usuários e duas chaves privadas separadas; o login do CLI permanece somente no perfil administrativo local.

Os 36 testes online de login, autorização, TOTP, convites, isolamento, suspensão e revogação passaram usando contas e registros descartáveis, removidos ao final. Outras 9 verificações de confirmação de e-mail e recuperação também passaram. O e-mail pessoal da dona foi confirmado, o papel administrativo concedido pelo bootstrap privado e a matrícula pessoal do autenticador concluída. O painel de lojistas e o segundo fator ativo foram conferidos em 25/10/2026.

Consulte [IMPLANTACAO-2026-10-24.md](IMPLANTACAO-2026-10-24.md) para configuração e validação. Na Square Cloud, manter `FIRESTORE_PREFER_REST=true`; o transporte HTTPS/REST resolveu os erros de conexão observados no gRPC. A API usa bearer/CORS de origem exata, sem cookies de terceiros.

Em 25/10/2026, o runtime digital foi implementado e a integração publicada na API/site. Cada bot ainda exige provisionamento de seu aplicativo exclusivo e um piloto real; publicar o site não inicia esses aplicativos. O checkout digital usa Stars, e novas vendas são bloqueadas em caso de suspensão/vencimento. Veja [BOT-TELEGRAM.md](BOT-TELEGRAM.md).
