# Checklist de aceitação

## Correção financeira — 20 pontos
- [ ] Dinheiro sem ponto flutuante.
- [ ] Valores decimais em strings e moeda explícita.
- [ ] Saldo e ledger atualizados atomicamente.
- [ ] Ledger append-only.
- [ ] LOSS não altera saldo.
- [ ] REFUND e ROLLBACK não podem ser duplicados.
- [ ] Reconciliação entre saldo e ledger.

## Concorrência — 20 pontos
- [ ] Duas apostas de 80 com saldo 100: uma aprovada, outra rejeitada, saldo 20.
- [ ] Sem lost updates ou saldo negativo.
- [ ] Carteiras distintas processam em paralelo.
- [ ] Testes com pelo menos três instâncias.

## Idempotência — 15 pontos
- [ ] 50 envios paralelos da mesma aposta geram um débito.
- [ ] Idempotência persistida no PostgreSQL.
- [ ] Mesma chave/payload retorna resultado original.
- [ ] Payload diferente com mesma chave gera conflito.
- [ ] Garantia sobrevive a reinícios.

## Mensageria — 15 pontos
- [ ] Inbox persistente.
- [ ] Outbox atômica com a operação.
- [ ] Eventos publicados somente após commit.
- [ ] Redelivery não duplica efeitos.
- [ ] Retries, backoff e DLQ testados.
- [ ] ACK somente após persistência durável.
- [ ] Crash e reinício recuperáveis.
- [ ] Referências atrasadas são recuperadas.

## Arquitetura — 10 pontos
- [ ] Domínio independente de NestJS, SQS e ORM.
- [ ] HTTP e worker compartilham os casos de uso.
- [ ] OPENING não pode ser submetido externamente.
- [ ] Regras de provedor e referência validadas.

## Testes — 10 pontos
- [ ] Testes unitários e de integração.
- [ ] PostgreSQL e SQS reais nos testes de integração.
- [ ] Migrations e constraints verificadas.
- [ ] Concorrência, reinício e publishers concorrentes testados.

## Observabilidade — 5 pontos
- [ ] Logs JSON sem segredos.
- [ ] Métricas operacionais.
- [ ] Liveness e readiness separados.

## Documentação — 5 pontos
- [ ] README reproduzível.
- [ ] Variáveis de exemplo sem segredos reais.
- [ ] Trade-offs e limitações documentados.

## Riscos eliminatórios
- [ ] Sem ponto flutuante para dinheiro.
- [ ] Sem saldo negativo por concorrência.
- [ ] Sem efeitos financeiros duplicados.
- [ ] Idempotência persistente.
- [ ] Múltiplas instâncias suportadas.
- [ ] Eventos somente após commit.
- [ ] Ledger auditável.
