# Continuar em outro computador

Este repositório contém o código da landing page e da primeira etapa da plataforma Blackout Create. Abra a branch do commit salvo, leia `README.md`, `SECURITY.md` e `docs/ESCOPOS-E-PENDENCIAS.md` antes de continuar.

## Executar

Requisitos: Node.js 24.12 ou superior e npm.

```sh
npm ci
npm run build
npm run local
```

Abra `http://127.0.0.1:3000`. O comando prepara Firebase Authentication emulado e PostgreSQL local. As contas de teste estão no README e aparecem no formulário de entrada local. Não usar dados reais nesse ambiente.

## Decisões do produto

- Marca: Blackout Create. Landing focada no bot de vendas no Telegram, com área reservada para login, primeiros passos, ativação e assinatura.
- A configuração operacional de produtos, categorias, estoque, banners, cupons, Pix e pedidos será pelo Telegram. Não construir um painel web de configuração operacional nesta primeira versão.
- O proprietário exige Firebase Spark, sem ativar faturamento, e já possui Square Cloud. Será um aplicativo de bot separado por cliente.
- O dono cadastra contratações recebidas por WhatsApp, Telegram, Discord ou outro canal, confirma a contratação, envia convite e aprova o acesso.
- O lojista segue o assistente BotFather/token/ID, revisa e envia os dados. O token é cifrado no servidor. O dono pode solicitar correção, iniciar a configuração e confirmar manualmente a ativação após instalar e testar o bot na Square Cloud.
- O período mensal começa somente nessa confirmação. Repetir a confirmação não reinicia nem estende o período. Ainda não há deploy, start/stop ou monitoramento remoto da Square Cloud.

## Estado e limites

A aplicação foi validada localmente com compilação, 14 testes de API e testes de navegador (incluindo convite, correção, ativação e layouts de 320 a 1440 pixels). Não está publicada nem conectada a um bot real. Configuração pública do Firebase está em `config/firebase.web.json`; ela não autoriza o servidor.

A migração dos dados da plataforma para Firestore foi discutida, mas ainda não foi implementada: o código atual usa PostgreSQL. O login/área reservada ainda depende da API na mesma origem. Publicar a parte restrita no Firebase Hosting exige concluir essa conexão, sem pressupor que o Spark hospede a API.

Faltam identidade Firebase Admin real, banco hospedado, segredos privados, segundo fator administrativo compatível com Spark e integração do runtime do bot. O controle de produção recusa administrador sem segundo fator; não remover essa proteção para publicar. Renovação e desligamento por vencimento ainda não foram integrados.

`VITE_CONTACT_URL` aguarda o link público oficial de atendimento. Não inventar preço comercial, depoimentos ou métricas. O contato, se configurado, é público; tokens, chaves privadas e senhas devem permanecer fora do Git e do chat.

O código original do bot recebido no arquivo `prisma.zip` foi examinado separadamente e ainda não foi incorporado ao runtime deste repositório. Os antigos mockups também não são a implementação atual. Para integrar o bot original em outra sessão, será necessário recuperar esse arquivo original. Revisar concorrência de estoque/entrega, transições de pagamento, tratamento de token e suspensão/reinício antes de colocá-lo em operação.

## Dados que não acompanham o Git

`.local/`, bancos e usuários do emulador, capturas de tela, dependências, builds, arquivos `.env`, contas de serviço e chaves privadas ficam excluídos. `npm run local` recria o ambiente de demonstração; a autenticação e os registros de desenvolvimento de outro ambiente não são transportados pelo commit.
