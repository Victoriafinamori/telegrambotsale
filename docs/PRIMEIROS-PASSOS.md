# Assistente de configuração do lojista

Depois de aceitar o convite e receber aprovação, o lojista entra em **Primeiros passos**. O fluxo usa a conta confirmada para identificar sua loja; não aceita um ID de loja escolhido pelo navegador.

1. **Criar bot:** abrir o BotFather oficial, enviar `/newbot`, escolher nome e username terminado em `bot`. Quem já tem bot encontra o token em `/mybots` → seu bot → API Token. Se o token tiver sido exposto, revogá-lo no BotFather antes de cadastrar o novo; combinar a troca se o bot já estiver ativo em outro servidor.
2. **Conectar:** informar o token em campo inicialmente oculto e seu ID pessoal do Telegram. A ajuda explica como obter o ID usando @userinfobot, identificado como terceiro e sem solicitar qualquer segredo. Quem não quiser esse serviço deve combinar a identificação com a equipe. Não enviar token por conversa, senha ou código de login. O servidor consulta somente `getMe`, sem iniciar o bot, enviar mensagens ou alterar webhooks.
3. **Revisar:** conferir o username confirmado pelo Telegram e o ID pessoal informado. O token fica cifrado no servidor e não retorna à tela do lojista. O rascunho reaparece ao entrar ou recarregar. Corrigir dados exige informar novamente o token.
4. **Enviar para ativação:** confirmar o envio e acompanhar o estado **Aguardando ativação**. A Blackout Create vê os dados no cadastro administrativo do lojista. O segredo é consultado somente por ação explícita e auditada para uso privado na Square Cloud, ficando visível por até 30 segundos no diálogo. O bot ainda não é iniciado por essa tela.

O ID informado não concede administração sozinho. Após preparar o runtime, o lojista usa **Confirmar minha conta no Telegram** no site e abre um link exclusivo, de uso único e validade de dez minutos. O bot confere o ID real da mensagem contra o ID cadastrado antes de liberar `/admin`. A equipe continua conferindo titularidade e migração de um bot já existente. Veja `BOT-TELEGRAM.md`.

## Persistência e criptografia

A migração `003_bot_onboarding.sql` cria `merchant_bot_setup`: um bot por loja e um vínculo exclusivo por bot. Rascunho e envio são persistidos, separados de aprovação, execução e cobrança. O assistente do lojista não altera `billing_started_at` ou `paid_through`. A migração `004_bot_activation.sql` acrescenta revisão, confirmação manual e unicidade do aplicativo Square Cloud. Apenas a confirmação administrativa da ativação inicia o período.

`BOT_TOKEN_ENCRYPTION_KEY` deve conter 32 bytes aleatórios codificados como base64url, guardados em configuração privada de servidor e separados dos backups do banco. Nunca colocar a chave no chat, frontend, Git ou pacote de código. AES-256-GCM usa nonce aleatório e dados autenticados vinculando loja/bot. Guardar cópia protegida da chave para recuperação; substituir a chave sem recifrar os dados torna os tokens anteriores ilegíveis. Rotação com recifragem ainda não foi implementada.

Sem a chave, a aplicação permite login e mostra o guia, mas recusa receber/abrir tokens. O servidor deve ter conectividade HTTPS ao Telegram; erros não incluem URLs ou tokens nas respostas/logs. Configurar migrações e os grants atualizados para o usuário de runtime.

## Desenvolvimento e pendências

`npm run local` gera sua própria chave em `.local/bot-token.key`, com permissão restrita, e a preserva entre execuções. Não usa nem aceita credenciais reais de Telegram. O botão **Preencher exemplo fictício** fornece um token de demonstração; tokens desse ambiente não criam bots reais. Os testes de API cobrem isolamento, cifragem, adulteração, consulta auditada, unicidade, suspensão e ausência de cobrança antecipada. O roteiro de navegador percorre as quatro etapas, recarrega para verificar persistência e consulta administrativa.

Antes da operação real: configurar Firebase Admin, banco e segredos na hospedagem; validar o segundo fator TOTP administrativo já implementado para Spark; ligar esses dados ao código corrigido do bot; verificar responsável e migração; testar ativação efetiva na Square Cloud e iniciar o ciclo mensal somente após o bot funcionar. O botão de confirmação manual já existe, exige atestar que o responsável foi conferido e que o bot foi instalado/testado. Ainda não existe verificação automática do processo nem deploy/start/stop remoto.

## Controles do dono da plataforma

Na aba **Ativações**, aparecem lojas aprovadas com dados enviados e aguardando ativação/configuração. O dono vê nome, e-mail, canal, contratação, bot, ID do bot, ID pessoal, datas e estado do envio. Tokens continuam fora das listagens e são consultados em ação explícita e auditada.

- **Iniciar configuração:** indica ao cliente que a equipe começou. Enquanto isso, alterações de token/ID pelo lojista ficam bloqueadas para evitar troca durante a instalação.
- **Solicitar correção:** exige motivo, exibe-o ao cliente e permite que ele corrija, valide e reenvie. A equipe precisa aguardar o reenvio antes de retomar a configuração.
- **Confirmar bot ativo:** após instalar e testar manualmente na Square Cloud, informar o ID exclusivo do aplicativo do cliente e confirmar os dois itens: identidade do responsável e funcionamento testado. O servidor registra quem confirmou, quando, o aplicativo e o período mensal. Isso é uma declaração do administrador, sem consulta automática à Square Cloud ou prova de execução.

Início e vencimento são gravados atomicamente, com um mês civil no fuso America/Sao_Paulo. Aprovação, envio, revisão e correção não iniciam o ciclo. Repetições não reiniciam/estendem o período. Revisões antigas, lojas suspensas, rascunhos e aplicativos já vinculados a outro cliente são recusados. Ações administrativas são auditadas sem registrar o segredo.

A confirmação não efetua cobrança financeira. O runtime agora inclui heartbeat, lembretes de vencimento e bloqueio de novas vendas quando suspenso ou vencido. **Suspender acesso ao painel** preserva dados, bloqueia a API da loja e novas vendas; o processo continua atendendo pagamentos anteriores e suporte. A renovação mensal é registrada pelo administrador após confirmar o recebimento externo. Provisionamento, piloto real e limites estão em `BOT-TELEGRAM.md`.
