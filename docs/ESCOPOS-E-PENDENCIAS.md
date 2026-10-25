# Estado da implementação — 25/10/2026

Decisão posterior: a configuração operacional também está disponível pelo site em `#/gestao`, usando os mesmos registros do Telegram. Consulte `PAINEL-DA-LOJA.md`. A suíte passou com 37 testes. A inspeção visual final depende de reativar o navegador local no Work ou da conferência manual da proprietária.

Atualização mais recente: personalização de produto/suporte, central de avisos, histórico completo, estatísticas e comprovantes com aprovação/recusa manual foram implementados conforme o pedido posterior da proprietária. Consulte `COMPROVANTES-E-AVISOS.md` para o comportamento atual de Pix/transferência e a limitação de compatibilidade Telegram. A proprietária liberou memória; o aplicativo piloto de 256 MB foi iniciado, a identidade pessoal foi confirmada e o menu `/admin` real foi observado pela proprietária. A suíte tem 34 testes aprovados; a compra/entrega real ainda precisa do roteiro de teste com catálogo e pagamento de demonstração.

## Infraestrutura e acesso concluídos

Site publicado em https://blackout-create.web.app e API em https://blackout-create-api.squareweb.app. Firebase Spark, Authentication, Firestore privado, identidade mínima do servidor, segredos separados e TOTP da dona foram configurados e verificados. Foram aprovadas 36 verificações online de autorização/convites/isolamento/revogação e nove de confirmação/recuperação de e-mail. Consulte `IMPLANTACAO-2026-10-24.md`.

O painel cadastra contratações de qualquer canal, confirma recebimento manualmente, gera convite de uso único, vincula o e-mail confirmado e permite aprovação, suspensão, revisão e ativação. Aprovar ou receber um token não inicia a mensalidade.

## Bot digital implementado

O runtime foi desenvolvido neste repositório a partir do escopo acordado, sem depender de ZIP antigo. Ele usa um aplicativo Square Cloud por lojista e credencial limitada à própria loja. Não recebe Firebase Admin nem chave de criptografia do servidor.

Inclui vínculo do responsável por link autenticado do site, catálogo, categorias, criação/edição de produtos, estoque cifrado de textos e arquivos, carrinho, cupons, Telegram Stars, pré-checkout, reserva concorrente, confirmação de pagamento, entrega, reentrega explícita, revisão/reembolso, histórico e atendimento pelo Telegram. Administração operacional fica no comando `/admin`, não no site.

A ativação confere runtime provisionado/online, identidade vinculada e aplicativo correspondente, além do atestado de teste funcional do administrador. Renovação é registrada após pagamento externo confirmado, com idempotência e mês civil em São Paulo. Há lembretes persistidos e bloqueio de novas vendas por suspensão ou vencimento. Reiniciar o processo não reativa a loja.

API e frontend com essa ligação foram publicados. Os 28 testes locais passaram, incluindo nove testes do bot com transporte Telegram simulado. O pacote mínimo do aplicativo foi compilado e sua instalação de dependências validada. Isso ainda não comprova execução com bot e pagamento reais. Leia `BOT-TELEGRAM.md`.

## Situação do piloto real

1. Aplicativo exclusivo de 256 MB criado após a liberação de memória pela proprietária. Nenhum outro aplicativo foi reduzido pelo assistente.
2. Loja piloto interna criada na conta já confirmada da dona, identificada como sem cobrança real. Ela mantém seu papel administrativo e acessa a própria loja pela rota `#/minha-loja`.
3. Bot fornecido pela proprietária validado e iniciado; segredo guardado apenas no armazenamento privado e cifrado no banco. Nenhum token foi enviado ao Git.
4. Credencial limitada da loja instalada no novo aplicativo. Heartbeat online conferido usando o relógio da API, para evitar falso offline pelo desvio local de horário.
5. A proprietária confirmou a identidade no Telegram e informou que o `/admin` apareceu. A identidade foi reconferida no Firestore e o piloto liberado para testar pedidos, sem cobrança real.
6. Próxima validação: configurar produto/estoque, atendimento e instruções de pagamento de teste; simular compra, envio de comprovante, aprovação/recusa, entrega e histórico. Não realizar pagamento real para provar o funcionamento. As funções simuladas já têm cobertura automatizada; o fluxo inteiro com pessoas no Telegram ainda precisa ser observado.

## Operação ainda necessária antes de atender clientes

Backup cifrado/restauração, retenção de updates/outbox/auditoria, monitoramento e limites de cota. O Firestore Spark tem cotas finitas; não há promessa de bots ilimitados. Pagamento financeiro automático da assinatura da plataforma não foi integrado; a renovação continua dependente da confirmação administrativa do recebimento. Migração de dados de PostgreSQL ou sistemas anteriores não é automática.

Um envio Telegram com resultado de rede incerto exige revisão; não há garantia de entrega exatamente uma vez. Reentrega preserva a mesma unidade vendida. Arquivos já entregues não podem ser recuperados por um reembolso. Essas condições precisam fazer parte da operação e do atendimento.
