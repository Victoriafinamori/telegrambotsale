# Produtos, atendimento, comprovantes e avisos

## Personalização pelo Telegram

No `/admin`, **Editar produto → Foto do produto** recebe uma foto opcional. O cliente vê a foto, nome, descrição, preço e botão de compra juntos. Sem foto, a mesma ficha aparece em texto. Enviar `remover` retira somente a imagem. Categorias não têm banner próprio, conforme o escopo escolhido.

O nome exibido acompanha o nome do bot configurado no BotFather. O runner consulta a identidade ao iniciar e novamente a cada cinco minutos; não altera o nome pelo painel. **Boas-vindas** e **Banner** continuam configurando a entrada da loja.

Em **Suporte**, configurar separadamente nome, telefone, link HTTPS e usuário Telegram. Cada campo aceita `remover`. O comprador vê os dados configurados e um botão para abrir o link; se não houver link, pode ser usado o usuário Telegram. URLs com credenciais ou protocolos executáveis não são aceitas. Nome sozinho não é suficiente para receber pedidos: é necessário telefone, usuário ou link de atendimento.

## Pagamento manual escolhido pela proprietária

A proprietária solicitou explicitamente **Pix/transferência com comprovante e aprovação manual**. Novas lojas iniciam nesse modo. **Pagamentos → Dados Pix/transferência** define o texto que aparece no checkout; **Editar produto → Preço** usa reais e aceita valores como `12,50`. O código não inventa chave Pix ou dados bancários e não confirma recebimento com base apenas na imagem.

O modo Stars permanece disponível para catálogos que o utilizam. Alterar a moeda é permitido somente antes de criar produtos e pedidos, para impedir que um preço seja reinterpretado. A assinatura paga à Blackout é separada das compras dos produtos do lojista.

**Compatibilidade:** o Telegram exige Stars para bens/serviços digitais vendidos dentro de seus aplicativos. O fluxo manual solicitado não deve ser apresentado como checkout aprovado pelo Telegram para arquivos e códigos; adequar o método à regra antes de operação pública. Referência: https://core.telegram.org/bots/payments-stars.

## Comprovante e análise

1. O comprador confirma o carrinho. O pedido salva os itens, quantidades, valor, nome e ID Telegram do comprador e reserva as unidades por vinte minutos.
2. No pedido, usa **Enviar comprovante** e manda foto ou arquivo pelo próprio bot. Ele não pode anexar comprovante a um pedido de outra pessoa.
3. O comprovante é cifrado no banco e encaminhado ao Telegram do responsável confirmado, junto de nome/usuário/ID do comprador, número do pedido, produtos, quantidade e total. A imagem não marca automaticamente a compra como paga.
4. O pedido fica **Comprovante aguardando aprovação**, com reserva por até 24 horas para análise. O dono encontra a fila em **Pagamentos pendentes** e pode abrir novamente o comprovante.
5. **Aprovar e entregar** registra o responsável/data, atualiza as estatísticas e agenda a entrega. A repetição da aprovação ou de um update não vende nem entrega outra unidade. O envio usa a mesma fila persistida e cifrada da aplicação.
6. **Recusar** exige um motivo. O comprador é avisado pelo Telegram, o motivo fica no histórico e a reserva volta ao estoque. Isso não executa uma devolução bancária: a aplicação não controla o banco do lojista.

O comprador pode atualizar o comprovante enquanto a análise está pendente. Cada versão tem revisão própria; botões de versões anteriores não aprovam o comprovante novo. Pedidos vencidos, recusados, pagos ou de outro usuário não aceitam aprovação indevida.

## Histórico e estatísticas

**Meus pedidos** e `/pedidos` mostram os pedidos recentes. **Histórico completo** percorre os registros anteriores com paginação. Cada detalhe informa produtos, quantidades, total, data, estado, motivo de recusa quando houver e botão para enviar/atualizar comprovante quando permitido. O histórico é limitado à conta Telegram do comprador.

**Estatísticas** mostra pedidos criados, compras aprovadas, compradores distintos, entregues, aguardando pagamento, aguardando aprovação, recusados e valores aprovados por moeda. **Compradores** permite consultar nome/usuário/ID, quantidade de compras e total aprovado. Valores refletem os registros e aprovações do sistema; não são um extrato bancário. Os contadores começam com os eventos desta implementação; importar pedidos de outro sistema requer migração própria.

## Avisos da loja

**Avisos → Criar aviso** recebe texto de até 900 caracteres e foto opcional, oferece prévia, edição e descarte. O envio exige o botão final de confirmação. O nome de um botão ou um ID informado por outra pessoa não concede permissão de envio.

Clientes ativam **Receber avisos** no menu do bot. **Parar avisos** ou `/pararavisos` cancela novos avisos sem remover compras ou suporte. A campanha usa somente inscritos da própria loja e limita o público ao momento da confirmação. Entradas posteriores não recebem uma campanha antiga.

O worker processa lotes pequenos, com cursor e IDs de mensagem determinísticos para não duplicar destinatários após reinício ou concorrência. Ele funciona separado do recebimento de pedidos. Cancelar uma campanha para os próximos envios; mensagens já em transmissão podem chegar. Histórico informa fila, enviados, falhas, resultado incerto e ignorados. Bloqueios do bot removem o destinatário dos próximos avisos; limite `429` respeita `retry_after`. Não há uso de broadcasts pagos.

## Verificação

Os testes automatizados usam transporte Telegram simulado. Cobrem foto opcional/remoção, suporte e URLs inválidas, nome do BotFather, recibos cifrados, comprador errado, revisão substituída, aprovação repetida, recusa/estoque, estatísticas, histórico paginado e avisos com confirmação, cancelamento, descadastro, reinício e retry. A suíte passou com 34 testes. Após a liberação de memória pela proprietária, um aplicativo piloto real de 256 MB foi instalado e seu heartbeat foi confirmado. O vínculo pessoal no Telegram e o teste de pedidos com o piloto continuam como etapas humanas de validação; execução do processo não comprova, isoladamente, venda/entrega real.
