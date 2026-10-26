# Banner unificado e Pix por produto

O banner de entrada usa uma única chamada `sendPhoto`, com boas-vindas em `caption` e menu em `reply_markup`. Sem banner, a entrada permanece em texto. Isso vale para novas mensagens; mensagens antigas do Telegram não são reescritas. Fotos de produto e avisos já usam legenda no mesmo envio.

Em Produtos → editar/criar, lojas no modo manual podem enviar um QR Code Pix opcional em JPG/PNG de até 3 MB. O lojista gera o QR no banco para o preço exato do produto. A API registra o preço associado ao QR; o navegador não decide esse vínculo.

O checkout envia o QR junto ao resumo e aos botões de comprovante somente para um produto, uma unidade, sem cupom e com total igual ao preço associado ao QR. Vários produtos, quantidade maior, cupom, QR ausente ou preço alterado usam as instruções Pix/transferência da loja. Mudar o preço não autoriza reutilizar um QR antigo para outro total. É necessário enviar um QR atualizado. O pedido continua aguardando comprovante e aprovação manual; uma imagem QR não confirma pagamento.

## Pix automático / Mercado Pago

Solicitado pela proprietária em 26/10/2026 e implementado na entrega seguinte. A aba Pagamentos agora oferece conexão individual e Pix automático. A configuração privada das credenciais e o teste de uma conta real continuam dependendo do lojista. Consulte MERCADO-PAGO.md para o fluxo implementado, validação e limites. O checkout manual permanece separado da integração automática.

A integração deve conectar a conta de cada lojista separadamente, armazenar credenciais cifradas apenas no servidor e nunca retornar Access Tokens ao frontend ou ao bot. Deve criar uma cobrança por pedido para o total calculado pelo servidor, inclusive carrinhos com vários itens, quantidades e cupons, usando chave de idempotência estável. Webhooks autenticados devem provocar consulta do pagamento na API oficial; valor, moeda, loja, referência e status precisam corresponder ao pedido. Confirmações repetidas ou fora de ordem não podem duplicar entrega. Expiração, falhas, cancelamentos, pagamentos tardios e reembolsos precisam de tratamento explícito. A ativação depende dessa implementação e da conexão privada da conta de pagamento, sem envio de tokens pelo chat.

As exigências do Telegram para vendas digitais permanecem documentadas em COMPROVANTES-E-AVISOS.md; definir o canal de checkout compatível antes de ativar outro provedor.

Referências oficiais consultadas: [legendas em fotos do Telegram](https://core.telegram.org/bots/api#sendphoto), [Pix Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix), [assinaturas de webhooks](https://github.com/mercadopago/sdk-nodejs/blob/master/docs/webhooks.md).

## Desempenho e validação

Leituras independentes de conta, configuração e loja são paralelizadas. Leituras repetidas do mesmo documento são compartilhadas apenas dentro da tentativa da transação, retornando cópias isoladas e respeitando as escritas pendentes. Não há cache de autorização entre requisições; revogação continua sendo validada. Estado observado na hospedagem: API aproximadamente 96 MB de 512 MB e bot aproximadamente 49 MB de 256 MB, ambos em execução. Isso afasta falta de memória nesse instante, sem comprovar ausência de outros gargalos.

Quarenta testes passaram, incluindo banner unificado, fallback sem imagem, QR de uma unidade e fallback para múltiplos itens/quantidades, cupons e alteração de preço. Nenhum pagamento real foi criado nesses testes. A percepção de latência real após a publicação deve ser medida no fluxo completo; não prometer que todos os gargalos foram eliminados.
