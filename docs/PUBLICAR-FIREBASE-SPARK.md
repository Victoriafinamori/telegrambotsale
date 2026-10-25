# Publicar no Firebase Spark e usar a API na Square Cloud

## O que já está preparado

Landing pública e área do cliente no Firebase Hosting; Firebase Authentication por e-mail/senha; Firestore como base central de contas, convites, assinatura e auditoria; API Node na Square Cloud; segundo fator TOTP do dono, sem Identity Platform ou Blaze. A configuração operacional das lojas continua no Telegram. Cada bot terá um aplicativo Square Cloud exclusivo; a API central do site é um serviço separado dos bots.

Em 24/10/2026, o frontend foi publicado em `https://blackout-create.web.app` e a API em `https://blackout-create-api.squareweb.app`, com identidade dedicada e segredos privados. O plano Firebase permanece Spark. O estado e as pendências do acesso do dono estão em [IMPLANTACAO-2026-10-24.md](IMPLANTACAO-2026-10-24.md). As etapas abaixo servem como referência para manutenção e novas publicações; a configuração Web pública não concede autorização administrativa.

## 1. Autorizar a conta Google

No terminal confiável em que você tem acesso ao navegador, dentro do repositório:

```sh
npm ci
npm run firebase:login
npm run firebase:status
```

Concluir o login no navegador usando a conta do projeto `blackout-create`. O perfil CLI fica em `.local/cli-config`, ignorado pelo Git, separado de credenciais do ambiente de execução. Não enviar códigos de login, tokens ou chaves privadas pelo chat. Estes comandos não habilitam faturamento.

## 2. Conferir o Firebase

No console do projeto `blackout-create`, manter o plano **Spark**. Habilitar Authentication → E-mail/senha. Criar o Firestore padrão caso ainda não exista, escolhendo conscientemente a localização; não excluir ou substituir um banco existente. Usar modo de produção, com as regras privadas deste repositório. Configurar política de senha, confirmação/recuperação e domínios autorizados mínimos.

```sh
npm run deploy:rules
```

`firestore.rules` nega acesso direto do navegador. Regras e índice da fila de ativações serão publicados. O servidor usa o SDK Admin via IAM e precisa de identidade dedicada de permissões mínimas, diferente das credenciais de criação/administração do projeto. Não há concessão pública de administrador pela interface ou pelas regras.

## 3. Preparar a API na Square Cloud

Confirmar se o plano existente suporta aplicação HTTP com HTTPS, Node 24.12+, porta encaminhada e armazenamento privado de credenciais. A existência de um aplicativo de bot não comprova suporte à API web. Não contratar upgrade ou recurso pago automaticamente.

Usar `ops/firebase-square.env.example` como referência. Definir `APP_ORIGIN` como a origem real do site, por exemplo `https://blackout-create.web.app`; `PLATFORM_DATABASE=firestore`; `API_AUTH_MODE=bearer`; `FIREBASE_HOSTING=false`. Confirmar a porta e a cadeia de proxy antes de alterar `TRUST_PROXY_HOPS`.

Configurar o SDK Admin com identidade de servidor: federação se suportada ou arquivo privado de conta de serviço, montado fora do código e referenciado por `GOOGLE_APPLICATION_CREDENTIALS`. Essa credencial nunca é usada no frontend ou distribuída aos bots dos clientes. Autorizar somente os acessos necessários a Authentication/Firestore; não dar Owner/Editor ao runtime.

Gerar as chaves de cifragem num ambiente privado:

```sh
npm run secrets:generate
```

O comando cria `.local/server-secrets.env` com duas chaves diferentes e permissão restrita. Não imprime os valores e não sobrescreve arquivo existente. Transferir somente para os segredos privados da hospedagem. Guardar cópia protegida para restauração. Substituir as chaves sem recifrar os dados torna os segredos anteriores ilegíveis.

Compilar com `npm run build` e iniciar a API com `npm start`, respeitando o mecanismo de implantação da Square Cloud. O banco central Firestore não precisa de `DATABASE_URL`, migrações SQL ou um PostgreSQL na nuvem. Os bancos e o runtime dos bots são uma etapa separada.

## 4. Preparar o frontend e publicar

Definir, no ambiente do build, `VITE_API_ORIGIN=https://endereco-real-da-api` e `VITE_CONTACT_URL` com o link comercial real. Só variáveis VITE públicas vão ao navegador; nunca colocar segredos nesses campos. A origem da API deve ser HTTPS exata, sem caminho ou barra final.

```sh
npm run deploy:hosting
```

O comando compila, gera `.local/firebase.hosting.json` e publica os arquivos estáticos no projeto autorizado. A CSP permite somente a origem exata da API, e a API aceita CORS somente da origem do site. Não há rewrite para Cloud Run/Functions nem dependência de cookies de terceiros.

Sem `VITE_API_ORIGIN`, a geração prepara somente a landing pública; login e painel ainda não funcionarão no Hosting. O modo bearer mantém a sessão por aba via SDK Firebase/sessionStorage, envia ID tokens pelo header Authorization e verifica revogação no servidor. O modo cookie original permanece para instalações na mesma origem e testes locais.

## 5. Criar o acesso do dono e ativar o segundo fator

Criar e confirmar sua conta pelo site. Em terminal privado com credencial do servidor e a configuração Firestore:

```sh
npm run admin:grant -- --uid UID_CONFIRMADO_DO_DONO
```

Entrar novamente no site. A tela exige configurar Google Authenticator, Microsoft Authenticator ou outro app TOTP: inserir manualmente a chave exibida e confirmar o código de seis dígitos. A semente fica cifrada no banco com chave própria; o código não pode ser reutilizado. A prova do segundo fator dura 15 minutos e é vinculada à credencial da sessão. Não compartilhar a chave do autenticador.

Recuperação após perda do autenticador exige o comando privado `npm run admin:mfa-reset -- --uid UID`, que remove a semente e revoga sessões. Não há rota pública para resetar ou desativar essa proteção. Configurar um novo autenticador após entrar novamente.

## 6. Testar no ambiente publicado

Testar confirmação/recuperação de e-mail real, login/logout e persistência por aba; matrícula e exigência do segundo fator; cadastro manual, convite de uso único e aceite com e-mail correspondente; isolamento entre clientes; envio cifrado de token/ID, correção e reenvio; ativação manual e datas sem reinício por repetição; rejeição de origem inválida e autorização indevida. Validar cota, logs sem segredos, backup/restauração e navegação em celular.

O período começa na confirmação manual do dono após instalar/testar o bot, não na contratação/convite. O site ainda não executa deploy/start/stop de bots nem renova ou desliga por vencimento. Não interpretar a página de divulgação ou o registro manual como prova de execução monitorada.

## Testes já disponíveis e limites

`npm run test:admin-browser` exercita matrícula TOTP e nova exigência após recarregar, com Firebase Auth emulado e armazenamento de domínio temporário. Executar com `npm run local` ativo.

`npm test` cobre os dois adaptadores do domínio, convites concorrentes, unicidade, cifragem, período mensal por mês civil, TOTP com vetores RFC, repetição de código, prova vinculada à sessão e CORS/bearer. O Firestore foi exercitado por um adaptador transacional em memória para testes, não contra o serviço real. O download do emulador Firestore falhou neste ambiente. `npm run local` continua isolado com Auth emulado e PostgreSQL local; `LOCAL_API_AUTH_MODE=bearer npm run local` permite verificar o novo transporte no navegador sem conta Google real.

O Spark tem cotas finitas. Limites, contas e auditoria consomem leituras/escritas. Não habilitar TTL pago, Cloud Functions, Cloud Run, exportações cobradas ou faturamento sem nova decisão do proprietário. A migração de dados de um PostgreSQL anterior não é automática; os dados locais de demonstração permanecem locais.
