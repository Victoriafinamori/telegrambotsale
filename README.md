# Blackout Create

Primeira etapa real da plataforma: acesso com **Firebase Authentication**, contratação manual por **WhatsApp, Telegram, Discord, site ou outro canal**, convites e aprovação administrativa. A base central pode usar Firestore (`PLATFORM_DATABASE=firestore`), com autorização conferida no servidor. PostgreSQL permanece disponível para compatibilidade e para a demonstração local. Não utiliza o código `DEMO` dos antigos mockups.

Além do acesso e onboarding, o repositório implementa o bot de produtos digitais: catálogo, categorias, carrinho, cupons, estoque cifrado, pagamento em Telegram Stars, entrega, reentrega, reembolso explícito, histórico, lembretes e bloqueio de novas vendas no vencimento/suspensão. Cada lojista usa um processo exclusivo na Square Cloud com credencial limitada à sua loja. A contratação da plataforma continua sendo confirmada manualmente. Aprovar o acesso ou enviar o token não inicia o período mensal nem provisiona sozinho um aplicativo.

Leia [BOT-TELEGRAM.md](docs/BOT-TELEGRAM.md) para o vínculo do responsável pelo site, publicação do processo, menu `/admin`, testes e limites. A implementação foi testada com transporte Telegram simulado; um piloto com bot e pagamentos no ambiente de teste oficial ainda é necessário antes de afirmar operação real. Para produtos digitais, o checkout usa `XTR`/Stars, conforme a regra do Telegram, sem Pix nesse fluxo.

## Site e área do cliente

A página inicial apresenta o bot de vendas no Telegram, com identidade Blackout Create, demonstração ilustrativa, explicação da contratação e botão Entrar. A área do cliente continua reservada a acesso, primeiros passos, ativação e assinatura; a configuração operacional da loja ficará no Telegram. Veja [docs/ESCOPO-DO-SITE.md](docs/ESCOPO-DO-SITE.md).

Para configurar o contato comercial, definir `VITE_CONTACT_URL` com o endereço público HTTPS real antes de executar o build. Enquanto não houver link, a seção de contratação informa a indisponibilidade do endereço oficial. A página pública abre sem a API; o login e o restante da área restrita ainda exigem o backend configurado.

## Executar com o emulador local

Requisitos: Node.js **24.12 ou superior**, npm e portas locais 3000/9099/4400/4500 disponíveis.

```sh
npm ci
npm run build
npm run local
```

Abra o endereço que o comando imprime no navegador. O comando inicia o emulador Auth e um PostgreSQL embutido (PGlite), ambos locais. Não precisa fornecer credenciais Google. Os dados ficam em `.local/`, ignorado pelo Git. Não use dados reais. Ao encerrar com Ctrl+C, o emulador exporta seus usuários para a próxima execução.

Contas **exclusivas do ambiente local**:

| Papel | E-mail | Senha local |
| --- | --- | --- |
| Administrador | `admin@blackout.test` | `BlackoutLocal!2026` |
| Lojista para experimentar convites | `lojista@blackout.test` | `BlackoutLocal!2026` |

Há botões na tela para preencher esses exemplos. Eles só aparecem com o emulador configurado. O servidor de produção não permite projeto `demo-`, host de emulador ou PostgreSQL embutido.

Para simular duas pessoas, use uma janela normal para o administrador e uma anônima para o lojista. A sessão real usa cookie e é compartilhada pelas abas do mesmo perfil do navegador.

## Fluxo disponível

1. Administrador entra e usa **Adicionar lojista**: nome, loja, e-mail, canal, referência e mensalidade contratada.
2. Confere a contratação recebida e clica **Confirmar contratação**. Essa ação é manual; não verifica um pagamento no banco.
3. Usa **Gerar convite**, copia o link e o envia pelo canal da contratação. A aplicação não envia mensagens por WhatsApp, Telegram ou Discord.
4. O lojista abre o convite, cria seu acesso e confirma o e-mail com o Firebase. No emulador, o link de confirmação aparece no terminal. Também pode entrar com uma conta já existente e confirmada.
5. O servidor confere que o e-mail confirmado corresponde à contratação e consome o convite uma única vez. A loja fica aguardando aprovação.
6. O administrador usa **Liberar acesso ao painel**. O lojista atualiza a situação e vê seus primeiros passos.
7. Após a aprovação, o lojista segue quatro etapas: criar o bot no BotFather, informar token e ID pessoal, revisar e enviar para ativação. O rascunho validado e o envio ficam salvos no servidor. No ambiente local, o assistente aceita somente tokens fictícios e não consulta o Telegram.
8. A equipe consulta os dados enviados e, em uma ação explícita e auditada, obtém o token para configurar a hospedagem privada na Square Cloud. Na aba Ativações, pode solicitar correção com motivo visível ao cliente ou marcar Em configuração. Depois de instalar/testar manualmente o bot, informa o ID exclusivo do aplicativo Square Cloud e confirma a ativação. Essa confirmação registra o início e o vencimento do período; não executa deploy/start na Square Cloud.
9. O administrador pode suspender e liberar novamente. A checagem é feita em toda requisição; o lojista continua entrando para consultar a situação, mas perde o acesso à API da loja.

Os convites duram sete dias. Gerar um novo revoga o anterior. Os tokens são armazenados somente como hash; o link completo é exibido apenas na geração. O endereço usa um fragmento para não colocar o token nos logs de acesso HTTP. A mensalidade fica sem início/vencimento até a confirmação manual da ativação pelo administrador. O vencimento é um mês civil depois, no fuso de São Paulo; repetir a confirmação não reinicia nem estende o período. Veja [docs/PRIMEIROS-PASSOS.md](docs/PRIMEIROS-PASSOS.md) para o assistente e os requisitos do segredo de criptografia.

## Testes

```sh
npm run check
npm test
npm run test:emulator
```

O último comando inicia e encerra seu próprio emulador; não rode com `npm run local` já usando a porta 9099. Usa o SDK Admin real contra o emulador para verificar e-mail, emissão de cookie e revogação de sessão.

Para testes completos das telas, mantenha `npm run local` em outro terminal:

```sh
npm exec playwright install chromium
npm run test:browser
```

Pode usar um Chromium já instalado definindo `CHROMIUM_PATH`. Os testes de navegador criam registros identificados como teste no banco local e capturam telas em `.local/screenshots/`. Nunca são executados contra Firebase real.

## Configurar Firebase e a hospedagem real

O aplicativo Web do projeto **blackout-create** já está registrado no código em `config/firebase.web.json`, incluindo o appId fornecido. Esse é o padrão para a execução real. `npm run local` continua usando apenas `demo-blackout-create`. O estado da conexão e os próximos requisitos estão em [docs/FIREBASE-PROJETO.md](docs/FIREBASE-PROJETO.md).

A estrutura preparada agora é **Firebase Spark para Authentication, Firestore e Hosting**, com API na Square Cloud existente. O frontend usa `VITE_API_ORIGIN` e o servidor usa `API_AUTH_MODE=bearer` com CORS de origem exata. Não depende de cookies de terceiros nem exige Blaze, Cloud Run ou Cloud SQL. Siga [docs/PUBLICAR-FIREBASE-SPARK.md](docs/PUBLICAR-FIREBASE-SPARK.md); o acesso real ao projeto e o suporte HTTPS da Square Cloud ainda precisam de confirmação.

1. Criar um projeto Firebase e registrar o aplicativo web. Habilitar Email/Password no Authentication e cadastrar apenas os domínios de acesso necessários.
2. Configurar política de senha, proteção contra enumeração de e-mails, modelos de confirmação/recuperação e proteção contra abuso. Não usar domínios locais em produção.
3. Copiar `.env.example` para `.env` apenas no ambiente privado. Em produção, usar variáveis/segredos da hospedagem, `NODE_ENV=production`, `APP_ORIGIN=https://seu-dominio`, `PLATFORM_DATABASE=firestore`, `API_AUTH_MODE=bearer`, sem variáveis de emulador. Para o adaptador PostgreSQL legado, usar `DATABASE_SSL=true`.
4. Para o SDK Admin, preferir identidade da carga de trabalho/ADC. Se uma chave de serviço for inevitável, montar o arquivo como segredo fora da imagem/repositório. Nunca usar a chave privada no navegador.
5. Executar `npm run build`. Firestore não usa migrações SQL: criar o banco pelo console, preparar/publicar regras e índices e autorizar uma identidade dedicada de servidor. Para PostgreSQL legado, executar `db:migrate` com credencial separada e aplicar os privilégios de `ops/application-grants.sql`.
6. Criar e confirmar a conta do administrador. Com acesso restrito ao servidor, conceder a permissão pelo UID do Firebase:

```sh
npm run admin:grant -- --uid UID_DO_FIREBASE
```

Não há botão público nem rota HTTP para alguém se tornar administrador. Remoção: `npm run admin:grant -- --uid UID_DO_FIREBASE --revoke`. O comando de bootstrap exige a credencial privada do servidor com autorização para o banco selecionado. Depois, o dono configura seu aplicativo autenticador na própria tela. Recuperação com acesso restrito: `npm run admin:mfa-reset -- --uid UID`.

7. Executar `npm start` atrás de um proxy HTTPS confiável. Configurar `HOST` e `TRUST_PROXY_HOPS` conforme a hospedagem; não confiar em headers de proxy sem essa necessidade. O Dockerfile fornece um runtime sem ferramentas de desenvolvimento e sem credenciais embutidas.

O Firebase identifica o usuário. As permissões e vínculos ficam no banco central selecionado; um papel ou ID de loja enviado pelo navegador não libera acesso. O runtime de bots usa Firestore e credenciais independentes por loja. A aplicação central recebe os updates do processo autorizado e mantém reservas, pedidos e entregas em transações. Nenhum ZIP antigo é necessário para executar essa implementação.

## Segurança e limites

Leia [SECURITY.md](SECURITY.md) e [docs/ESCOPOS-E-PENDENCIAS.md](docs/ESCOPOS-E-PENDENCIAS.md). Esta etapa foi validada localmente; não equivale a auditoria externa nem a liberação para produção. A autenticação multifator compatível com Spark já tem implementação local; a validação real, hospedagem e integração dos bots ainda precisam ser concluídas antes da venda como serviço operacional.
