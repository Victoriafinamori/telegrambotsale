# Ativação automática na Square Cloud

A API executa uma fila persistida no Firestore a cada 15 segundos. A integração começa desativada e só é habilitada após a administradora conectar uma chave própria da Square Cloud no painel, com segundo fator confirmado.

## Conexão

Em Administração da plataforma, abra **Hospedagem automática dos bots**. Crie uma chave na Square Cloud, em Minha conta → Segurança, com `account:read`, `apps:read`, `apps:write`, `apps:control` e `envs:write`. Cole no formulário privado e escolha habilitar as novas ativações. O backend valida `/v2/users/me` antes de cifrar a chave; não devolve a credencial ao navegador. Não são usados login CLI, tokens Google nem credenciais Firebase dentro dos aplicativos dos lojistas.

A chave da Square é uma credencial de infraestrutura da Blackout. Ela permanece somente no servidor da plataforma. O aplicativo de cada lojista recebe apenas `NODE_ENV`, `PORT`, `BOT_API_ORIGIN` e uma credencial de runtime limitada àquela loja. O token Telegram continua cifrado no backend e é entregue ao runtime autenticado já existente.

## Fluxo

1. O checkout confirma o pagamento e libera uma conta vinculada ao e-mail verificado.
2. O lojista salva o token e seu ID pessoal; o Telegram valida o token.
3. Ao enviar para ativação, uma conta aprovada e com contratação confirmada entra na fila. Bots já ativos ou com runtime manual não são migrados.
4. O worker confere identidade do bot, ausência de webhook anterior e memória livre. Ele não remove webhooks ou para aplicativos existentes.
5. A Square cria um aplicativo exclusivo, chamado `Blackout-<UUID da loja>`, com Node 24 e 256 MB. Não há contratação ou aumento automático do plano.
6. O backend registra uma credencial por loja, instala-a nas variáveis privadas do aplicativo e reinicia somente esse aplicativo.
7. Quando o runtime conectar, o lojista usa **Confirmar minha conta no Telegram**, abre o link com a conta de ID informado e toca em Iniciar.
8. Somente com runtime recente, vínculo correto, responsável confirmado e aplicativo em execução, o sistema registra a ativação e inicia os 1, 3 ou 12 meses contratados. A operação é idempotente.

O lojista acompanha os estados na configuração e pode atualizar a situação. Não há polling de telas que descarte formulários ou feche o diálogo de confirmação.

## Falhas e retomadas

- Falta de memória, chave sem permissão, token revogado ou webhook anterior: pendência no acompanhamento administrativo. O período não começa. Corrija a causa e use **Conferir e retomar ativação**.
- Timeout ou reinício durante upload: o estágio é persistido antes do POST. A retomada consulta os aplicativos pelo nome exclusivo da conta; nunca repete cegamente o upload.
- Nenhum aplicativo ou mais de um com esse nome após resposta ambígua: a conciliação continua pendente, exigindo inspeção pela administradora. O botão de retomada apenas consulta novamente, sem novo POST.
- Falha ao instalar variáveis privadas: o ID do aplicativo e a credencial cifrada são preservados; a retomada reutiliza o mesmo aplicativo e a mesma credencial.
- Conta suspensa, dados alterados ou contratação indisponível: a ativação é interrompida para conferência.
- Pausar novas ativações impede o processamento da fila; aplicativos existentes permanecem intactos. Uma operação externa já em andamento pode concluir sua publicação, mas não é cancelada ou apagada automaticamente.

Há uma exclusão global persistida com vencimento de cinco minutos, além da proteção local contra ticks simultâneos. Cada tick processa no máximo um job, com cursor para não bloquear novas lojas atrás de outras aguardando o responsável. As chamadas têm limites de tempo menores que a concessão da exclusão. A fila volta a ser processada após reinício da API.

O pacote enviado usa uma lista explícita: runner compilado, cliente Telegram, package.json sem dependências e squarecloud.app. Não contém código da plataforma, chaves de cifragem, Admin SDK, inventário ou credenciais de outros lojistas.

## Validação

`tests/automatic-activation.test.ts` cobre publicação única sob concorrência, confirmação de dono correto, início único de três meses, capacidade insuficiente, retomada de upload ambíguo, configuração privada repetível, webhook existente, suspensão e proteção da chave. Os provedores são simulados; isso não substitui uma contratação real seguida da publicação de um bot novo.

Referência oficial: https://github.com/squarecloudofc/sdk-api-js/blob/main/spec/openapi.json
