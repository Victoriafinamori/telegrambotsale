# Firebase Spark e Square Cloud

A estrutura atual está documentada em [PUBLICAR-FIREBASE-SPARK.md](PUBLICAR-FIREBASE-SPARK.md): Firebase Hosting para o frontend, Authentication para identidade, Firestore para a base central e API própria na Square Cloud existente. Manter Spark; não ativar Blaze, Cloud Run ou Cloud Functions.

A comunicação entre origens foi implementada com `VITE_API_ORIGIN`, `API_AUTH_MODE=bearer`, CORS de origem exata e SDK Firebase com sessão por aba. A geração `npm run firebase:prepare` cria configuração estática de Hosting com a origem exata da API na CSP. Sem endereço real de API, somente a landing pública funciona no Hosting.

O modo anterior de cookie na mesma origem continua disponível. O envelope opcional `FIREBASE_HOSTING=true` e seus testes foram preservados para compatibilidade, mas não é usado no caminho Spark com API externa. Não há rewrite para backend pago.

A conta Google do proprietário ainda precisa ser autorizada no perfil CLI. Nenhum site, banco, serviço pago ou configuração de IAM foi publicado por esta etapa. Não confundir código preparado/testes locais com funcionamento no projeto real.
