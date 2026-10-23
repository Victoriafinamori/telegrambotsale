# Firebase Spark e Square Cloud

O proprietário confirmou **Firebase Spark, sem ativar faturamento**, e informou que já possui **Square Cloud** para hospedar os bots. A proposta de Firebase Hosting com Cloud Run foi substituída.

Firebase Authentication permanece no projeto `blackout-create`. O caminho proposto é servir painel e API juntos na mesma origem HTTPS da Square Cloud, aproveitando sua infraestrutura para os bots. Suporte a aplicações web, limites do plano e hospedagem PostgreSQL ainda precisam ser confirmados. Consulte [SQUARE-CLOUD.md](SQUARE-CLOUD.md).

`firebase.json` configura somente os emuladores. Não há rewrite para Cloud Run nem publicação de Hosting configurada: o painel depende de `/api/config` e de sessões na mesma origem, então publicar somente `dist/` no Firebase Hosting não produz uma aplicação funcional.

O modo opcional `FIREBASE_HOSTING=true` e seus testes foram preservados, mas ficam desativados na Square Cloud, que usa os cookies normais protegidos da aplicação.

Nenhum recurso foi publicado, nenhum faturamento foi ativado e nenhuma credencial da Square Cloud foi utilizada. A verificação remota do Firebase continua pendente: a consulta anterior foi bloqueada pelo proxy deste ambiente e não há conta do proprietário autorizada no CLI.
