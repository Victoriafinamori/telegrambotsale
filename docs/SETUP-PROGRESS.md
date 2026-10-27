# Acompanhamento da configuração

O painel mostra cinco etapas: **Pagamento confirmado → Conectar bot → Confirmar responsável → Configurar loja → Loja pronta**. O mesmo componente aparece na visão geral da loja e em `#/configuracao`.

As etapas aparecem em uma faixa compacta, com detalhes de uma etapa por vez. No celular, a faixa vira uma lista curta. O botão **Fechar** oculta o acompanhamento e guarda a preferência neste navegador, por bot. **Retomar configuração** permite reabrir sem perder os fatos salvos no servidor. O fechamento não suspende nem ativa a loja.

Ao atingir **Loja pronta**, o acompanhamento deixa de aparecer automaticamente na visão geral. A preferência de fechamento é preservada para não reabrir o assistente por uma oscilação posterior de conexão ou estoque. O acesso comum à página de configuração redireciona para a loja quando estiver pronta. O item **Ativação e conexão** do menu usa `?review=1` para uma revisão explícita, e a contratação continua acessível via `?contract=1`. Mesmo na revisão existe um botão para voltar à loja.

## Retomada

O backend calcula o acompanhamento a partir da conta, configuração do bot, runtime e loja já persistidos no Firestore. Não há um número de etapa mantido apenas no navegador. Sair, trocar de dispositivo ou atualizar a página preserva os fatos salvos. Campos ainda não enviados não são considerados concluídos; tokens não são guardados em localStorage.

- A contratação precisa ter `purchase_confirmed_at`.
- A conexão precisa de configuração enviada, runtime não revogado e o mesmo ID de bot, em configuração ou ativo.
- A confirmação exige o dono vinculado ao mesmo bot e ID pessoal informado.
- A loja precisa de mensagem de entrada, ao menos um produto habilitado com preço e estoque, um canal de suporte e forma de pagamento configurada. Banner é opcional.
- Loja pronta também exige assinatura ativa, acesso aprovado e heartbeat recente do bot. É um indicador da configuração básica, não prova de uma transação real ou garantia de disponibilidade futura.

Para Pix automático Purin, o acompanhamento confere geração da conexão, existência da credencial e a subconta vinculada à loja. Solicitar a habilitação não conclui o requisito. Mercado Pago exige conexão daquela loja; Stars não exige chave Pix. A verificação usa os registros locais e não cria cobranças nem consulta credenciais de pagamento no navegador.

Cada etapa oferece a próxima ação quando disponível: compra, conexão, confirmação do Telegram, áreas específicas da gestão ou abertura do bot. Links de configuração direcionam por `?section=appearance|products|stock|support|payments|overview`, com lista permitida. Links para renovação e carteira continuam compatíveis.

Ao voltar à visão geral pelo menu, os dados são atualizados, incluindo mudanças salvas na tela de pagamentos. Não há atualização automática que sobrescreva formulários em edição ou feche diálogos. O botão Atualizar consulta novamente os registros.

As leituras são protegidas pelo usuário autenticado e não recebem o ID da loja do cliente. Elas não ativam o bot, não iniciam a assinatura e não alteram pagamentos. Se estoque zerar, a assinatura vencer ou o runtime perder conexão, o acompanhamento apresenta a pendência correspondente. Uma confirmação de dono pertencente a outro bot nunca conclui a etapa.

## Limite durante a migração

A preparação Hyze permanece separada deste recurso. Novas publicações automáticas continuam pausadas até a proprietária decidir migrar e conectar o provedor. O acompanhamento permite ver o envio e a espera pela hospedagem, mas não declara um bot conectado antes de existir um runtime correspondente.

## Validação

`tests/setup-progress.test.ts` cobre retomada em novas leituras, requisitos reais, estoque zerado, pagamento automático pendente, dono incorreto, assinatura vencida, bot offline/revogado, suspensão e isolamento HTTP. A suíte completa passou com 93 testes após a inclusão do acompanhamento.
