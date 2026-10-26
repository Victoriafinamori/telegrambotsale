# Assinaturas e renovação Blackout

Planos configurados em produção por autorização da dona: mensal (1 mês), R$ 9,99; trimestral (3 meses), R$ 24,50; anual (12 meses), R$ 84,90. Os preços ficam em platform_billing/settings e são editáveis somente pelo administrador com MFA nas rotas /api/admin/subscription-plans.

O administrador pode atribuir o plano inicial antes da ativação. O ciclo inicial só começa após ativação efetiva; no Firestore a data respeita billing_months (padrão legado de 1 mês). A contratação inicial pode ocorrer pelo checkout público autenticado descrito abaixo, ou pelo cadastro/convite da equipe.

O lojista usa Minha loja → Assinatura, ou /assinatura no seu bot. Os lembretes privados do bot incluem Renovar meu bot a 10, 5, 3, 2 e 1 dia e no vencimento. A manutenção do worker verifica as datas aproximadamente a cada 45 segundos enquanto online. Cada aviso é único por vencimento/faixa, e avisos enfileirados de um vencimento antigo são descartados após renovação. Compradores não veem o menu de assinatura do lojista.

O Pix de assinatura usa a conta principal Purin, sem subaccountId. É receita da plataforma, não saldo de vendas dos lojistas. Não debita a carteira da loja. A tela confere plano e preço antes de gerar, e bloqueia uma confirmação com preço antigo. Apenas uma cobrança aberta/conferência por loja é reutilizada; preço, período, usuário e geração da conexão ficam congelados.

O callback exclusivo /payments/subscriptions/:generation valida HMAC sobre corpo bruto, identidade do evento e consulta a cobrança ao provedor. Moeda, ambiente live, valor, ausência de subconta e metadados precisam corresponder. O recibo do pagamento e extensão do acesso são atômicos e idempotentes. Renovação antecipada soma meses ao vencimento; vencida soma ao momento da confirmação. Não há débito recorrente automático.

Timeout de criação nunca gera POST repetido: conserva a tentativa em conferência; Verificar pagamento consulta o ID ou pesquisa a tentativa pelo externalId. O caso não localizado na página limitada do provedor exige suporte, sem nova cobrança automática. Pagamento tardio ou para conta suspensa/vínculo alterado exige conferência, não restaura acesso silenciosamente. Não há reembolso automático deste fluxo.

Credenciais e código Pix ficam privados/cifrados. Novas coleções são negadas pelas regras padrão do Firestore. Acesso deriva da identidade Firebase; preços e períodos não são aceitos do comprador. Nenhuma cobrança foi criada na validação de produção, nenhum vencimento real foi alterado e nenhum pagamento bancário real foi feito nesta implementação.

Validação: testes de preço congelado, criação concorrente única, falha de rede, webhook inválido, isolamento HTTP, datas trimestrais/anuais e cinco lembretes; inspeção local desktop/móvel sem overflow. Pagamento real e recebimento futuro dos lembretes ainda precisam ser acompanhados em uso.

## Checkout inicial no site

O CTA Quero meu bot agora abre /#/comprar. A página exibe os planos públicos, o resumo do valor, perguntas frequentes e Tem alguma dúvida? com atendimento no Telegram. A contratação inicial exige login com e-mail confirmado antes de gerar Pix. O retorno do login preserva o checkout e o plano selecionado na sessão.

A confirmação autoritativa de uma fatura purpose=initial cria atomicamente o cadastro merchant_accounts e seus índices platform_uids/platform_emails, vincula a identidade verificada, confirma a contratação e libera o painel para onboarding. Não cria bot, não concede administração da plataforma, não inicia hospedagem e não inicia o período; billing_started_at e paid_through continuam nulos até a ativação. Contas/e-mails já contratados são direcionados para conferência ou renovação, sem vinculação automática a uma conta antiga. Nenhum convite por e-mail é necessário para esta modalidade, pois a identidade já foi verificada antes do pagamento.

Uma reserva privada por identidade/e-mail evita cobrança inicial concorrente; a fatura congela plano/preço/identidade. Uma resposta de criação desconhecida é conciliada sem novo POST. Pagamento tardio ou conflito de cadastro vai para review_required, sem sobrescrever conta existente. O checkout não recebe UID, preço livre ou accountId do cliente. O cliente recebe o QR local e o código de sua própria fatura; dados pessoais de outras contas e segredos do provedor não são expostos.
