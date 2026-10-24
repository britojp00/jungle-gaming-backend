# Jungle Gaming — Backend Challenge

Implementação independente do desafio:
https://github.com/junglegaming/backend-challenge

## Objetivo
Processar apostas e resultados com precisão monetária, concorrência segura, idempotência persistente, ledger auditável e mensageria recuperável.

## Stack
- Bun 1.x
- TypeScript estrito
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS + LocalStack
- Docker Compose

## Princípios
- Dinheiro como string decimal, nunca `number` ou float.
- Saldo, ledger, transação e outbox devem ser consistentes atomicamente.
- Idempotência deve sobreviver a reinícios.
- Ledger append-only: correções são lançamentos compensatórios.
- PostgreSQL é a autoridade para concorrência e invariantes.
- Eventos somente após commit.
- Testes reais com múltiplas instâncias.

## Documentação
Consulte `PLAN.md`, `ARCHITECTURE.md` e `ACCEPTANCE_CHECKLIST.md`.
