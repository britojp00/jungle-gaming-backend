# Instruções do projeto — Jungle Gaming Backend

## Objetivo
Implementar o desafio oficial Distributed Wagering Processor.
Fonte de verdade: https://github.com/junglegaming/backend-challenge

Antes de implementar um requisito, consulte o README oficial e a documentação local relevante.

## Documentação obrigatória
- `README.md`: instalação, execução e utilização.
- `PLAN.md`: etapas e prioridades de implementação.
- `ARCHITECTURE.md`: decisões, invariantes, trade-offs e limitações.
- `ACCEPTANCE_CHECKLIST.md`: requisitos a validar antes da entrega.
- `PROGRESS.md`: cronologia do trabalho, decisões, problemas resolvidos e validações executadas.

Mantenha esses documentos atualizados quando decisões ou comandos mudarem.

## Stack obrigatória
- Bun 1.x como runtime, gerenciador de pacotes e test runner.
- TypeScript em modo estrito.
- NestJS.
- PostgreSQL.
- MikroORM, preferencialmente, com migrations versionadas e reversíveis.
- AWS SQS usando LocalStack ou MiniStack.
- Docker Compose.

Não use Prisma nem substitua PostgreSQL/SQS reais por mocks nos testes de integração.

## Invariantes financeiras
- Nunca represente dinheiro com `number`, `float` ou `double`.
- Receba e serialize valores monetários como strings decimais com duas casas.
- Mantenha `Money` imutável e independente do NestJS e do ORM.
- O ledger é append-only: não atualizar nem excluir lançamentos.
- Nunca permita saldo negativo.
- O saldo materializado deve reconciliar com o ledger.
- Idempotência deve ser persistida no banco, nunca apenas em memória.
- Constraints e índices do banco devem reforçar as invariantes.
- Não dependa apenas de SQS FIFO para garantir consistência.
- Não publique eventos antes do commit financeiro.
- Alterações de uma mesma wallet devem ser seguras entre múltiplas instâncias.
- Inbox, operação financeira e outbox devem respeitar a atomicidade exigida pelo desafio.

## Processo de trabalho
1. Leia as instruções e os arquivos relacionados antes de alterar código.
2. Trabalhe em etapas pequenas e verificáveis.
3. Antes de implementar, informe brevemente o objetivo, os arquivos envolvidos e a abordagem.
4. Não implemente funcionalidades não solicitadas nem amplie o escopo sem justificar.
5. Não substitua dependências ou decisões arquiteturais sem explicar o motivo.
6. Não declare uma etapa concluída sem executar as verificações aplicáveis.
7. Ao encontrar falha, investigue a causa antes de alterar outras partes.
8. Não remova testes nem enfraqueça asserções para fazer a suíte passar.
9. Não invente resultados de testes, comandos executados ou funcionalidades.
10. Ao finalizar cada etapa, apresente resumo, arquivos alterados, testes executados e pendências.

## Segurança e configuração
- Nunca grave credenciais reais, tokens ou segredos no Git.
- Use `.env.example` com valores ilustrativos e mantenha `.env` fora do versionamento.
- Não exponha payloads financeiros completos nos logs.
- Não execute operações destrutivas no banco sem autorização explícita.
- Não faça commit automaticamente sem solicitação.

## Verificação
Depois que os scripts forem definidos, execute os comandos reais de lint,
typecheck, testes unitários e testes de integração pertinentes às alterações.
Confira os scripts existentes antes de presumir que um comando está disponível.

Prioridades: correção financeira, concorrência, idempotência, mensageria e recuperação,
arquitetura, testes, observabilidade e documentação.
Autenticação é opcional e não deve atrasar as prioridades obrigatórias.
