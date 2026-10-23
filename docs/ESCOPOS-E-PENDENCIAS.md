# Estado da implementação

## Entregue e exercitado localmente

Aplicação web compilada e API Express com Firebase Authentication; conta, confirmação/recuperação de e-mail, sessão de servidor, saída e revogação; cadastro administrativo de contratações por qualquer canal, incluindo Discord; confirmação manual da contratação, convite de sete dias, vínculo pelo e-mail confirmado, aprovação e suspensão; autorização, separação por UID/loja, auditoria e limites persistidos no PostgreSQL.

Há um assistente de quatro etapas com instruções do BotFather, obtenção do ID pessoal, validação de token por getMe, rascunho e envio persistidos, cifragem AES-256-GCM e consulta administrativa auditada para configuração na Square Cloud. O ID informado ainda precisa ser conferido pela equipe; ele não libera permissões. No ambiente local, o Telegram é simulado e só aceita tokens fictícios.

O painel informa o estado real. Não há pedidos fictícios nem contadores de vendas inventados. Cadastro/contratação/aceite/liberação não alteram `billing_started_at` ou `paid_through`. A aba Ativações permite revisão, solicitação de correção e confirmação manual após instalação/teste na Square Cloud. Somente essa confirmação define início/vencimento por mês civil no fuso de São Paulo. O ID do aplicativo é exclusivo por cliente. Não há verificação automática do processo, deploy ou comandos remotos de start/stop.

Os testes cobrem autorização indevida, outro e-mail, convite revogado/vencido/reutilizado e uso concorrente; cookie, sessão falsa/revogada, login antigo, e-mail não confirmado, CSRF/origem, corpo grande, entrada inválida, limites e configuração de produção. Firebase Admin é exercitado contra o emulador Auth. O roteiro de navegador cobre cadastro por Discord, convite, aprovação/suspensão, saída, escape de HTML e larguras de 320 a 1440 pixels.

## Escopo definido para o site

O site terá divulgação pública, login, primeiros passos, ativação e assinatura. A landing page já foi implementada e abre sem depender da API. Configuração operacional da loja será pelo Telegram. A proposta de configurar catálogo/estoque/banners pelo site foi retirada desta primeira versão; ver `ESCOPO-DO-SITE.md`. A migração dos cadastros da plataforma para Firestore foi discutida, mas ainda não foi implementada: o código continua usando PostgreSQL.

## Próximo bloco: bot e loja

1. Importar/consolidar o código do bot original no repositório, corrigindo as falhas identificadas antes de iniciar seus processos ou publicar webhooks.
2. Ligar a conta aprovada e os dados cifrados do assistente a um Tenant, implementar verificação operacional do responsável e gestão de rotação/revogação. O token já é validado, exclusivo entre lojas e cifrado no servidor. Não exigir que o lojista hospede o bot.
3. Integrar provisionamento e verificação de execução na Square Cloud, com um aplicativo por cliente. Hoje o início do período depende da confirmação explícita do administrador após instalação/teste manuais. O código original tem um manager compartilhado de tenants e precisa ser adaptado para iniciar somente a loja vinculada ao aplicativo.
4. Consolidar catálogo, banners, categorias/ordenação, estoque por conteúdo, cupons, Pix manual/QR, comprovantes, estados de pagamento/entrega, acessos históricos e suporte no bot, com administração operacional pelo Telegram.
5. Reservar e entregar estoque transacionalmente, com tratamento de repetição de pagamentos, pagamento tardio e falha de envio.
6. Executar avisos, reposição e recorrência em workers persistentes; lembretes em 10, 5, 3 e 1 dia.
7. Confirmar a renovação manual ou pelo provedor e aplicar mês civil. Suspender novas vendas no vencimento, preservar o painel e garantir que reiniciar o servidor não reative lojas suspensas.

## Publicação e início de vendas

Manter Firebase Spark, validar a aplicação web/API na Square Cloud já existente, definir PostgreSQL, domínio, HTTPS e identidade de servidor; concluir MFA administrativo compatível com Spark e os requisitos de SECURITY.md; testar backup/restauração e monitoramento; validar o fluxo completo com lojas piloto. Ainda não há URL pública publicada, cobrança real ou Telegram conectado nesta entrega.
