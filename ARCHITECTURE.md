# Arquitetura — decisões iniciais

## Stack
Bun 1.x, TypeScript estrito, NestJS, PostgreSQL, MikroORM, AWS SQS, LocalStack e Docker Compose.

## Módulos propostos
- `wallets`: carteira e saldo.
- `wagering`: operações BET, WIN, LOSS, REFUND e ROLLBACK.
- `ledger`: lançamentos imutáveis.
- `idempotency`: chaves e hashes de payload.
- `messaging`: inbox, outbox, workers e publishers.
- `health`: liveness e readiness.

## Dinheiro
Criar `Money` imutável usando decimal exato. Entrada e saída devem usar valores como `"25.00"` e moeda explícita. Nunca converter dinheiro para `number`. Rejeitar escala inválida e moedas incompatíveis.

## Consistência
Saldo, transação financeira, ledger e outbox devem ser gravados na mesma transação SQL. O ledger é append-only. Reversões criam novos lançamentos compensatórios.

## Concorrência
Avaliar lock pessimista da linha da carteira dentro de uma transação PostgreSQL. Não usar locks em memória como garantia. Constraints do banco devem proteger as invariantes.

## Idempotência
Persistir chave, escopo e hash canônico do payload. Mesma chave e mesmo payload retornam o resultado original; payload diferente gera conflito.

## Mensageria
A inbox deduplica mensagens. A outbox registra eventos atomicamente com a operação. O publisher envia somente após commit. ACK da SQS somente após persistência durável. Configurar retries e DLQ.

A entrega é at-least-once com deduplicação; não prometer exactly-once entre PostgreSQL e SQS.

## Referências
REFUND e ROLLBACK precisam apontar para operações elegíveis. Se a referência ainda não existir, persistir como pendência recuperável. Nunca reverter a mesma operação duas vezes.

## Autenticação
Opcional no desafio. Se houver tempo, integrar um IdP externo/OIDC, como Keycloak. Não implementar autenticação artesanal.

## Observabilidade
Logs JSON com IDs de correlação, sem segredos ou payloads financeiros completos. Métricas de transações, duplicatas, retries, DLQ, locks e atraso da outbox.

## Testes
Unitários para Money e regras de domínio. Integração real com PostgreSQL e LocalStack. Testar duplicatas, concorrência, reinícios, referências atrasadas e reconciliação do saldo com o ledger.
