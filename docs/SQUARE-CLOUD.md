# Square Cloud com Firebase Spark

## Estrutura escolhida

- **Firebase Spark:** autenticação por e-mail/senha no projeto `blackout-create`, dentro das cotas gratuitas. Não habilitar Blaze ou recursos que exijam faturamento.
- **Square Cloud existente:** um aplicativo separado para cada cliente, conforme escolha do proprietário. O ID do aplicativo fica vinculado à ativação e não pode ser reutilizado por outra loja. Para painel e API, a proposta é uma aplicação Node que serve ambos no mesmo domínio HTTPS. Isso preserva cookies e proteção de origem, sem comunicação entre domínios.
- **PostgreSQL:** contas, convites, permissões, auditoria e futuros dados de loja. O endereço e a hospedagem ainda não foram definidos; a existência da Square Cloud não comprova que um banco esteja incluído.

Não foram consultados conta ou limites da Square Cloud. Antes do envio, verificar se o plano comporta API HTTP, bots e recursos necessários sem upgrade. Se atender somente bots, painel/API ainda precisará de outra solução.

## Preparar a aplicação

O servidor atual entrega `dist/` e `/api/*`. Exige Node.js 24.12 ou superior, conectividade HTTPS com Firebase/Telegram e PostgreSQL com TLS verificado.

```sh
npm ci
npm run build
npm start
```

Esses são comandos da aplicação, não um deploy validado da Square Cloud. Ajustar build e inicialização ao mecanismo suportado pela hospedagem. Não enviar `node_modules`, `.local`, `.env`, credenciais ou usuários do emulador no pacote de código.

`ops/square-cloud.env.example` referencia as variáveis públicas. Substituir a origem pelo endereço HTTPS real, confirmar a porta HTTP e manter `FIREBASE_HOSTING=false`. Validar a cadeia de proxy antes de mudar `TRUST_PROXY_HOPS`.

Painel e API devem compartilhar a mesma origem. Publicar o painel no Firebase Hosting com uma API em outro domínio exige implementação específica para configuração, CORS, cookies e CSRF; não está preparado nesse formato.

## Credenciais e dados

Usar uma identidade Firebase Admin dedicada com permissões mínimas. Preferir federação de identidade quando suportada. Se for necessário arquivo de conta de serviço, montá-lo somente no servidor com acesso restrito e apontar `GOOGLE_APPLICATION_CREDENTIALS`. Nunca enviar a chave ao chat, Git, pacote de código, logs ou navegador. Confirmar que a hospedagem permite armazená-la com esse isolamento.

Definir `DATABASE_URL` em configuração privada e `DATABASE_SSL=true`. Migrações usam credencial separada; runtime usa `ops/application-grants.sql`. PGlite e `.local/` são exclusivos do desenvolvimento. Definir backup e recuperação antes de usar dados reais.

No console Firebase, cadastrar o domínio real e validar política de senha, e-mails e proteção contra abuso. A configuração Web pública não autoriza o SDK Admin.

## Pendências antes da operação

1. Confirmar HTTP, HTTPS, Node, limites, segredos e persistência na Square Cloud existente, além do banco disponível.
2. Implementar MFA administrativo compatível com Spark. A checagem atual exige segundo fator informado pelo Firebase e precisa ser adaptada a uma solução independente de upgrade. Não remover o bloqueio para publicar.
3. Integrar o código original do bot e corrigir as falhas identificadas. O servidor atual ainda não inicia bots nem publica na Square Cloud.
4. Ligar o registro de ativação manual à verificação operacional. Hoje o administrador instala/testa o bot fora do painel e confirma a ativação para iniciar o período mensal. Não há chamadas à API Square Cloud, monitoramento, renovação ou desligamento automático. O código original compartilhava vários tenants por processo e precisa ser adaptado à execução de um cliente por aplicativo.
5. Validar login, convites, isolamento entre lojas, cookies HTTPS, revogação, CSRF, rate limit, logs e recuperação na hospedagem real.

Esta preparação não realizou deploy, acessou a conta Square Cloud ou alterou serviços ativos. Testes locais não comprovam funcionamento na hospedagem real.
