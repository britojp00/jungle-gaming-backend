---
name: persistence-concurrency
description: Projete e revise MikroORM, PostgreSQL, migrations, locks por wallet, constraints, idempotência persistente, inbox e transactional outbox.
---

# Persistência e concorrência

Antes de alterar persistência, consulte as seções 5, 8, 10 e 11 do README oficial do desafio e leia ARCHITECTURE.md.

## Regras
- PostgreSQL é a fonte de verdade para as garantias financeiras.
- Use MikroORM; não introduza Prisma.
- Migrations devem ser versionadas e reversíveis.
- Aplique constraints e índices no banco para reforçar unicidade, imutabilidade e não-negatividade.
- Toda operação financeira deve ser atômica: transação, wallet, ledger e eventos outbox.
- Para mensagens SQS, inclua inbox na mesma transação conforme o contrato do desafio.
- A estratégia de concorrência deve funcionar entre múltiplos processos.
- Locks devem ser específicos da wallet, não um lock global.
- Evite read-calculate-update sem proteção contra lost updates.
- Garanta que uma mesma chave de idempotência não produza efeitos duplicados.
- Use claims/locks adequados para publishers concorrentes da outbox.
- A publicação de eventos acontece após o commit, via outbox.
- Nunca dependa exclusivamente da ordenação ou deduplicação do SQS FIFO.

## Ao implementar
1. Explique a estratégia de transação e concorrência antes de codificá-la.
2. Crie migrations e constraints junto com a alteração de modelo correspondente.
3. Teste com PostgreSQL real em container.
4. Teste requests concorrentes e múltiplas instâncias, não apenas mocks sequenciais.
5. Verifique atomicidade, reinicialização, redelivery e recuperação após falhas.
6. Documente trade-offs e limites em ARCHITECTURE.md.
