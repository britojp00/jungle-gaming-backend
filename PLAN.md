# Plano de implementação — 3 dias

## Dia 1 — Fundação e domínio
- [ ] Verificar Bun, Docker e Git.
- [ ] Criar NestJS com TypeScript estrito.
- [ ] Configurar PostgreSQL e Docker Compose.
- [ ] Implementar Money imutável com decimal exato.
- [ ] Modelar Wallet, WagerTransaction e Ledger.
- [ ] Configurar MikroORM e migrations.
- [ ] Garantir saldo e ledger atômicos.

**Aceite:** aplicação executa, lint/testes passam e operações financeiras usam transações reais.

## Dia 2 — Concorrência e mensageria
- [ ] Implementar idempotência persistente.
- [ ] Mesma chave e payload: retornar resultado original.
- [ ] Mesma chave com payload diferente: conflito.
- [ ] Implementar locking por carteira no PostgreSQL.
- [ ] Criar endpoints exigidos pelo README oficial.
- [ ] Implementar inbox, outbox e SQS.
- [ ] Configurar retries, backoff e DLQ.
- [ ] Tratar referências recebidas fora de ordem.

**Aceite:** 50 duplicatas não duplicam o débito; duas apostas de 80 contra saldo 100 resultam em uma aprovação e saldo 20.

## Dia 3 — Resiliência e entrega
- [ ] Testar pelo menos três instâncias/processos.
- [ ] Testar crash após commit e antes do ACK.
- [ ] Testar publishers concorrentes e reinícios.
- [ ] Validar reconciliação entre saldo e ledger.
- [ ] Implementar logs JSON, métricas e health checks.
- [ ] Revisar README e comandos reproduzíveis.
- [ ] Rodar todos os testes e revisar o Git.

## Prioridades
1. Correção financeira: 20 pontos.
2. Concorrência: 20.
3. Idempotência: 15.
4. Mensageria e falhas: 15.
5. Arquitetura: 10.
6. Testes: 10.
7. Observabilidade: 5.
8. Documentação: 5.

Autenticação é opcional; não deve atrasar o núcleo financeiro.
