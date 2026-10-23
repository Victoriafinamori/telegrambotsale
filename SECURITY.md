# Segurança da primeira etapa

## Controles implementados

- Firebase Admin verifica a assinatura e o projeto dos tokens, a confirmação do e-mail e a revogação. Cookies são emitidos apenas após login recente (cinco minutos), com validade de oito horas.
- Em produção, cookie `__Host-`, Secure, HttpOnly, SameSite=Strict, sem Domain. O navegador mantém a autenticação do SDK somente em memória; após obter o cookie, encerra a sessão cliente do SDK. Tokens Firebase não são gravados em localStorage.
- Para Firebase Hosting, que filtra os demais cookies, o modo `FIREBASE_HOSTING=true` usa somente `__session`, HttpOnly/Secure/SameSite=Strict e sem Domain, com envelope assinado que mantém a sessão Firebase e o token CSRF. Esse modo opcional não é usado na implantação escolhida na Square Cloud. Se utilizado, a chave de assinatura é obrigatória em produção e deve ficar em um gerenciador de segredos, compartilhada entre instâncias. O Firebase Admin continua verificando a sessão assinada pelo provedor e sua revogação. Veja `docs/FIREBASE-HOSPEDAGEM.md`.
- A ativação exige contratação confirmada, acesso aprovado, dados enviados e em configuração, revisão atual e declarações explícitas do administrador sobre identificação e teste do bot. O aplicativo Square Cloud é exclusivo por cliente; transação e bloqueio de linha impedem período duplicado ou cobrança iniciada por conflito. Essa confirmação é manual, sem comprovação automática de execução na hospedagem.
- Rotas administrativas consultam a tabela de administradores a cada solicitação. O bootstrap é um comando de servidor. Suspensão da loja é conferida no servidor; remover uma permissão tem efeito nas requisições seguintes.
- A loja do usuário é obtida pelo UID verificado. A API da loja não aceita IDs de outras lojas como forma de autorização. O usuário não escolhe seu papel.
- Convites com 256 bits aleatórios, somente hash SHA-256 no banco, validade, revogação de anteriores, e-mail correspondente e consumo transacional. O estado do convite e da conta é novamente conferido sob bloqueio de linha. Convites não confirmam compra nem iniciam mensalidade.
- Requisições de alteração exigem JSON, origem exata e token anti-CSRF em cookie HttpOnly/header. Há limite de corpo, validação estrita dos campos e consultas SQL parametrizadas.
- Limites de requisições ficam no PostgreSQL e são compartilhados entre instâncias. O IP é derivado somente da conexão/proxy explicitamente confiável e transformado em hash para a chave do limite.
- CSP sem scripts inline, bloqueio de incorporação em iframe, no-referrer, nosniff e HSTS em produção. As respostas de API não podem ser cacheadas. O HTML não recebe segredos de servidor.
- Os campos cadastrados são escapados antes de entrar no HTML. A chave pública do Firebase web é configuração pública; não concede autorização na API.
- Erros HTTP retornam mensagens controladas e ID da requisição. O logger não imprime corpos, senhas, cookies, tokens ou URLs de convite. A auditoria registra ações, UID do ator e conta afetada sem conteúdo do convite.
- Projeto demo/emulador, HTTP e banco sem TLS são recusados em produção. URLs de banco com opções SSL conflitantes são rejeitadas. O runtime Docker não inclui o Firebase CLI, PGlite ou ferramentas de testes.

## Limitações conhecidas e requisitos antes de produção

- A API já bloqueia administradores sem segundo fator em produção, verificando a informação no token validado pelo Firebase. A implantação precisa permanecer no Spark: não habilitar Identity Platform/MFA que exija upgrade como requisito. Falta implementar um segundo fator independente no servidor (por exemplo, TOTP), sua matrícula, recuperação e integração com a autorização atual. O bloqueio existente não deve ser removido para contornar essa pendência. Por isso a administração em produção ainda não está liberada para uso.
- Habilitar as proteções contra enumeração, política de senha e antiabuso no projeto Firebase real. A interface recomenda 12 caracteres, mas a imposição da política ao provedor é uma configuração do projeto; a interface, isoladamente, não é uma barreira de segurança.
- Recuperação/confirmação de e-mail usam o Firebase. Os testes locais não verificam entregabilidade de e-mail real, domínio de envio ou todas as configurações do projeto de produção.
- O limite da API não substitui os controles do Firebase Authentication: o endpoint do provedor é público e tem sua própria proteção contra abuso. Avaliar App Check/reCAPTCHA e proteção de borda na publicação.
- Senhas e tokens só trafegam com TLS na produção. A simulação local HTTP/loopback não deve ser exposta à rede. As contas locais predefinidas são proibidas como credenciais de produção.
- O assistente recebe tokens somente de lojas aprovadas, valida `getMe` e armazena AES-256-GCM com nonce aleatório e AAD vinculando loja/bot. `BOT_TOKEN_ENCRYPTION_KEY` fica fora do banco, navegador e Git; ausência da chave impede o recebimento. Metadados e auditoria não retornam o token. Consulta explícita pelo administrador exige permissão, CSRF e é auditada; o segredo é exibido temporariamente (30 segundos) para transferência à hospedagem privada. O ID pessoal informado não é prova de titularidade nem concede autorização. Ainda faltam verificação operacional do responsável, rotação gerenciada e controle da instância do bot. Mudanças de credencial por este assistente ficam bloqueadas após o início do ciclo mensal; a rotação de bots ativos exige fluxo separado.
- O início/vencimento do período já pode ser registrado manualmente pelo dono. O vencimento ainda não dispara desligamento do aplicativo na Square Cloud, e suspender o painel não para o bot. A integração operacional e a renovação continuam pendentes.
- O bot original ainda precisa corrigir concorrência de estoque/entrega, transições de pagamento e suspensão/reinício. Ele não é iniciado por esta entrega e seus webhooks não ficam expostos pelo novo servidor.
- Implementar backups cifrados e testar restauração, retenção/privacidade, monitoramento, alertas e resposta a incidentes antes de atender clientes reais. A trilha de auditoria em tabela não é imutável contra um administrador do próprio banco.
- Validar TLS, cookies, autorização e limites na hospedagem real. Os testes locais não substituem revisão independente, teste de intrusão ou controles de operação.

## Dependências

A auditoria executada nesta revisão não apontou vulnerabilidades conhecidas nas dependências de produção. O override de `@grpc/grpc-js` substitui a versão antiga trazida pelo SDK web por uma versão corrigida da mesma linha principal; o aplicativo usa somente os módulos app/auth.

O Firebase CLI é restrito ao desenvolvimento e foi encontrado com avisos conhecidos em dependências transitivas de observabilidade, monitoramento de arquivos e HTTP. Não foi aplicado override de versão principal nessas bibliotecas sem compatibilidade demonstrada. O CLI não entra no runtime de produção e os emuladores escutam somente em loopback. Acompanhar atualizações; executar novamente `npm audit` e `npm audit --omit=dev` a cada atualização. Ausência de avisos não prova ausência de falhas.

## Relatar e responder

Não publique tokens ou dados de clientes em issues. Use um canal privado definido pelo proprietário da Blackout Create. Em caso de acesso indevido, remover a permissão administrativa, suspender a conta pertinente e revogar as sessões no Firebase; investigar os IDs de requisição e a auditoria sem divulgar os dados sensíveis.
