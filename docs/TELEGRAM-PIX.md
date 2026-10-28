# Pix no Telegram

Pedidos novos com PurinCash oferecem **Gerar Pix** como ação do próprio bot.
O servidor usa o checkout privado do pedido e o fluxo idempotente já existente
da Purin para gerar a cobrança. O BR Code retornado gera um PNG local, enviado
como foto com legenda, total, validade, verificação e cancelamento.

Quando o código cabe no limite de 256 caracteres do Telegram, o cartão inclui
o botão **Copiar Pix**. Códigos maiores seguem em mensagem monoespaçada para
cópia, sem redirecionamento. O bot não baixa imagens de URLs do provedor.

Somente o comprador do pedido pode gerar o Pix. A chave do checkout e os efeitos
ficam cifrados. Pedidos pagos, cancelados ou expirados não enviam QR pendente.
Cliques concorrentes reutilizam a cobrança e o efeito, sem novo débito.

Pedidos antigos preservam seus links de checkout. Mercado Pago continua usando
o checkout web para coletar os dados do pagador; esta alteração é para PurinCash.

## Validação

- `npm test`: 119 testes aprovados, incluindo concorrência, propriedade do pedido,
  supressão de QR cancelado e transporte PNG multipart com controles.
- `npm run check`: aprovado.
- Os pacotes da API e do worker devem ser publicados juntos, API primeiro.
  Parar o worker piloto antes de atualizar seu ZIP evita dois consumidores.
- Após publicar, validar a saúde e gerar um novo pedido no Telegram para conferir
  o envio real. O pagamento bancário continua sendo realizado pelo comprador.
