# Estado da implementação — 25/10/2026

## Infraestrutura e acesso concluídos

Site publicado em https://blackout-create.web.app e API em https://blackout-create-api.squareweb.app. Firebase Spark, Authentication, Firestore privado, identidade mínima do servidor, segredos separados e TOTP da dona foram configurados e verificados. Foram aprovadas 36 verificações online de autorização/convites/isolamento/revogação e nove de confirmação/recuperação de e-mail. Consulte `IMPLANTACAO-2026-10-24.md`.

O painel cadastra contratações de qualquer canal, confirma recebimento manualmente, gera convite de uso único, vincula o e-mail confirmado e permite aprovação, suspensão, revisão e ativação. Aprovar ou receber um token não inicia a mensalidade.

## Bot digital implementado

O runtime foi desenvolvido neste repositório a partir do escopo acordado, sem depender de ZIP antigo. Ele usa um aplicativo Square Cloud por lojista e credencial limitada à própria loja. Não recebe Firebase Admin nem chave de criptografia do servidor.

Inclui vínculo do responsável por link autenticado do site, catálogo, categorias, criação/edição de produtos, estoque cifrado de textos e arquivos, carrinho, cupons, Telegram Stars, pré-checkout, reserva concorrente, confirmação de pagamento, entrega, reentrega explícita, revisão/reembolso, histórico e atendimento pelo Telegram. Administração operacional fica no comando `/admin`, não no site.

A ativação confere runtime provisionado/online, identidade vinculada e aplicativo correspondente, além do atestado de teste funcional do administrador. Renovação é registrada após pagamento externo confirmado, com idempotência e mês civil em São Paulo. Há lembretes persistidos e bloqueio de novas vendas por suspensão ou vencimento. Reiniciar o processo não reativa a loja.

API e frontend com essa ligação foram publicados. Os 28 testes locais passaram, incluindo nove testes do bot com transporte Telegram simulado. O pacote mínimo do aplicativo foi compilado e sua instalação de dependências validada. Isso ainda não comprova execução com bot e pagamento reais. Leia `BOT-TELEGRAM.md`.

## Necessário para o piloto real

1. Deixar pelo menos 256 MB disponíveis na Square Cloud para o aplicativo do lojista. A última consulta mostrou 88 MB livres; faltam 168 MB. Não reduzir aplicativos existentes sem decisão da proprietária.
2. Cadastrar uma loja piloto e concluir o convite com uma conta de lojista. A dona da plataforma mantém seu papel administrativo.
3. Criar/escolher o bot no BotFather e informar o token somente no formulário protegido do site. Não enviar segredos pelo chat.
4. Publicar o pacote do runtime em aplicativo exclusivo e instalar somente sua credencial privada. O upload/provisionamento é uma operação da equipe, ainda sem botão automático no painel.
5. Confirmar o responsável no Telegram, configurar catálogo/estoque/atendimento e executar o fluxo completo da web até pagamento e entrega no ambiente de teste oficial do Telegram. Não realizar cobrança real para provar o funcionamento.

## Operação ainda necessária antes de atender clientes

Backup cifrado/restauração, retenção de updates/outbox/auditoria, monitoramento e limites de cota. O Firestore Spark tem cotas finitas; não há promessa de bots ilimitados. Pagamento financeiro automático da assinatura da plataforma não foi integrado; a renovação continua dependente da confirmação administrativa do recebimento. Migração de dados de PostgreSQL ou sistemas anteriores não é automática.

Um envio Telegram com resultado de rede incerto exige revisão; não há garantia de entrega exatamente uma vez. Reentrega preserva a mesma unidade vendida. Arquivos já entregues não podem ser recuperados por um reembolso. Essas condições precisam fazer parte da operação e do atendimento.
