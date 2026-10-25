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

A aplicação foi validada localmente com compilação, 19 testes automatizados e testes de navegador (incluindo convite, correção, ativação, modo cookie, modo bearer, matrícula TOTP e layouts de 320 a 1440 pixels). Não está publicada nem conectada a um bot real. Configuração pública do Firebase está em `config/firebase.web.json`; ela não autoriza o servidor.

A base central agora tem adaptador Firestore (`PLATFORM_DATABASE=firestore`) e o caminho Hosting → API externa foi implementado com `VITE_API_ORIGIN`, `API_AUTH_MODE=bearer` e CORS exato. PostgreSQL fica disponível para compatibilidade e demonstração local. Os registros antigos não são migrados automaticamente. O segundo fator TOTP do dono também foi implementado sem Blaze. Leia `docs/PUBLICAR-FIREBASE-SPARK.md` para autorização, configuração e publicação.

Esses requisitos de infraestrutura foram concluídos em 24–25/10/2026, com autorização da proprietária e testes online. O TOTP pessoal da dona está ativo. O runtime digital foi implementado e integrado à API; o próximo passo é o piloto real descrito em `BOT-TELEGRAM.md`. Novas vendas são bloqueadas por suspensão/vencimento e há renovação mensal registrada manualmente após confirmação externa de pagamento. Não remover o segundo fator para publicar.

`VITE_CONTACT_URL` aguarda o link público oficial de atendimento. Não inventar preço comercial, depoimentos ou métricas. O contato, se configurado, é público; tokens, chaves privadas e senhas devem permanecer fora do Git e do chat.

Atualização de 25/10/2026: o runtime foi implementado neste repositório a partir do escopo de produtos digitais, sem depender de `prisma.zip`. Use `docs/BOT-TELEGRAM.md` como referência atual de provisionamento, vínculo de identidade, Stars, estoque e entrega. Não solicitar o ZIP antigo como pré-requisito. Infraestrutura/API/site e segundo fator da dona foram concluídos; a próxima validação é o piloto Telegram real, com aplicativo exclusivo e espaço disponível na Square Cloud.

## Dados que não acompanham o Git

`.local/`, bancos e usuários do emulador, capturas de tela, dependências, builds, arquivos `.env`, contas de serviço e chaves privadas ficam excluídos. `npm run local` recria o ambiente de demonstração; a autenticação e os registros de desenvolvimento de outro ambiente não são transportados pelo commit.
