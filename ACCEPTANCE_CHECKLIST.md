# Checklist de aceitação

Referência: README oficial https://github.com/junglegaming/backend-challenge

Legenda de estado:
- **Concluído** — implementado e com evidência concreta (arquivo + teste).
- **Parcial** — implementado em parte, ou sem a validação exigida.
- **Pendente** — sem implementação ou sem qualquer evidência.

> Regra adotada: nenhum item dependente de **execução em múltiplas
> instâncias/processos** está marcado como concluído. A **concorrência real**
> tem teste em PostgreSQL real (`concurrency.integration.e2e-spec.ts`), a
> **publicação de eventos** está implementada e testada
> (`outbox-publisher.integration`, `wager-command-consumer.integration`) e a
> **API HTTP** também (`http.integration.e2e-spec.ts`); a frente de
> **múltiplos processos** continua aberta.

---

## Riscos eliminatórios

### 1. `number` para dinheiro — **Concluído**
Falha eliminatória se `number`/`float`/`double` representar dinheiro.
- **Evidência:** `src/domain/shared/value-objects/money.ts` usa `decimal.js`
  e expõe apenas `MoneyProps` (`{ amount: string; currency: string }`). Não
  há campo monetário em `number`: todas as colunas são `numeric(20,2)` e as
  entidades as mapeiam como `string` (ex.:
  `src/infrastructure/persistence/entities/wallet.entity.ts`, propriedade
  `balance!: string`).
- **Testes:** `src/domain/shared/value-objects/money.spec.ts` valida serialização
  exata e rejeição de faixa fora de `numeric(20,2)`.
- **Falta:** nada. É a única falha eliminatória que está encerrada.

### 2. Saldo negativo causado por race — **Concluído**
- **Implementado:** `Wallet.debit` recusa saldo negativo; CHECK
  `wallets_balance_non_negative` existe na migration e é verificada por teste
  real (`test/integration/postgres.integration.e2e-spec.ts`); lock pessimista
  em `WalletRepository.findByIdForUpdate` usado pelo `ProcessBetUseCase` e
  pelo `ProcessWinUseCase` (nas duas rotas, crédito e aceite pendente);
  unique `wallets_player_currency_unique` no banco.
- **Evidência de concorrência real:** `test/integration/concurrency.integration.e2e-spec.ts`
  executa 2, 5 e 50 apostas simultâneas sobre a mesma carteira (o cenário
  obrigatório do README 8: 80,00 + 80,00 sobre saldo 100,00 → uma PROCESSSED,
  uma REJECTED, saldo final 20,00, um único débito) e 5 aberturas simultâneas
  da mesma carteira. Após cada cenário o saldo persistido é conferido por SQL
  cru: nunca negativo, reconciliado com o ledger e `version` coerente.
- **Escopo honesto:** as requisições concorrentes usam `EntityManager` e
  conexões distintas dentro de um processo. A exigência de **múltiplas
  instâncias** é coberta pelo risco 5, que continua pendente.

### 3. Débito ou crédito duplicado — **Parcial**
- **Implementado:** `ProcessBetUseCase` e `ProcessWinUseCase` fazem replay
  por `(providerId, idempotencyKey)` com `payload_hash`, devolvendo o
  resultado original — inclusive uma `WIN` ainda `PENDING_REFERENCE`, que o
  replay **não** resolve.
- **Evidência de concorrência real:** as mesmas 50 requisições paralelas com
  o mesmo conteúdo geram **uma** transação, **um** débito e um único saldo
  (49 replays do resultado original), verificado por SQL em
  `test/integration/concurrency.integration.e2e-spec.ts`; o cenário de 2 e 5
  apostas concorrentes também gera exatamente um débito. Para a **WIN**,
  duas requisições idênticas concorrentes geram **uma** transação e **um**
  crédito (`test/integration/win.integration.e2e-spec.ts`).
- **Agora implementado:** `LOSS`, `REFUND` e `ROLLBACK` têm caso de uso
  (`ProcessLossUseCase`, `ProcessReversalUseCase`) com as regras 3, 4, 5 e 9
  verificadas em PostgreSQL real (`test/integration/reversal.integration.e2e-spec.ts`);
  a unicidade da reversão continua no schema
  (`wager_transactions_reversal_unique`). **Falta comprovar:** a deduplicação
  dessas reversões sob concorrência entre processos (ver risco 5).

### 4. Idempotência apenas em memória — **Parcial**
- **Evidência de persistência:** `payload_hash` e `idempotency_key` são colunas
  de `wager_transactions` (migration + entidade); `ProcessBetUseCase` grava o
  hash e o relê do banco.
- **Evidência em PostgreSQL real sob concorrência**
  (`test/integration/concurrency.integration.e2e-spec.ts`): replay idêntico
  50× (1 original + 49 replays, uma única transação), conflito com conteúdo
  diferente na mesma wallet e conflito entre wallets distintas — este último
  **reproduziu uma falha real** (erro cru de unique em vez de
  `IDEMPOTENCY_PAYLOAD_CONFLICT`) que foi corrigida no `ProcessBetUseCase`.
- **Falta demonstrar:** a garantia sob **reinício** do processo não foi
  testada (a persistência em banco existe, mas não há teste de reinício).

### 5. Solução correta somente com uma instância — **Pendente**
- **Falta demonstrar:** não há execução com três instâncias nem qualquer teste
  de concorrência entre processos. O lock é de banco (correto por
  construção), mas **não verificado**.

### 6. Publicação de evento antes do commit — **Concluído**
- **Implementado:** `OpenWalletUseCase`, `ProcessBetUseCase` e
  `ProcessWinUseCase` gravam a outbox na mesma transação SQL da operação
  financeira, e o publisher (`OutboxPublisherWorker`) só lê linhas já
  confirmadas. A atomicidade foi **provada negativamente**: um proxy no
  `EntityManager` força uma falha **após** o `flush` da outbox e a suíte
  confere que saldo, ledger, transação e outbox foram desfeitos
  (`win.integration.e2e-spec.ts`), e que nada é publicado após um rollback
  (`outbox-publisher.integration.e2e-spec.ts`).
- **Publicação, marcação `PUBLISHED` e ack após commit** estão implementados e
  testados em PostgreSQL + LocalStack reais (`outbox-publisher.integration`,
  `wager-command-consumer.integration`).

### 7. Ausência de ledger auditável — **Parcial**
- **Evidência:** tabela `wallet_ledger_entries` com CHECKs
  (`wallet_ledger_amount_positive`, saldos não negativos,
  `wallet_ledger_balance_consistent`) e proteção contra alteração **no banco**:
  `CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE` em
  `src/migrations/Migration20261024021931_InitialSchema.ts`. O domínio
  `WalletLedgerEntry` é imutável por construção.
- **Exercitado agora:** o trigger foi testado em
  `test/integration/postgres.integration.e2e-spec.ts` (`UPDATE` e `DELETE`
  rejeitados com "Wallet ledger entries are immutable"). A reconciliação
  saldo ⇄ ledger é verificada por SQL nos testes de concorrência
  (`wallet.balance == saldo reconstruído pelo ledger`).
- **Falta demonstrar:** **não há endpoint nem caso de uso** de reconciliação
  em produção (`isBalanced()` existe apenas no domínio).

### 8. Testes que substituem completamente PostgreSQL e SQS por mocks — **Concluído**
- **Evidência:** os fakes (`test/support/fake-entity-manager.ts`) são usados
  **apenas** nos testes unitários e modelam só a orquestração. Existe suíte de
  integração real: `bun run test:integration` com
  `compose.integration.yaml` (PostgreSQL e LocalStack isolados), cobrindo
  rollback (inclusive provocado no fluxo do `ProcessWinUseCase`),
  constraints, atomicidade de `OpenWalletUseCase`/`ProcessWinUseCase` e fila
  SQS.
- **Limitação honesta:** a cobertura real é **parcial** — inclui concorrência
  em PostgreSQL real, mas não inclui publicação de eventos nem múltiplas
  instâncias. O requisito de não depender exclusivamente de mocks está
  cumprido; a cobertura completa, não.

---

## Correção financeira — 20 pontos
- [x] Dinheiro sem ponto flutuante. — `Money`/`decimal.js`; risco eliminatório 1.
- [x] Valores decimais em strings e moeda explícita. — `MoneyProps`; moeda `^[A-Z]{3}$` obrigatória.
- [x] Saldo e ledger atualizados atomicamente. — OPENING, BET e WIN verificados em PostgreSQL real, inclusive sob concorrência (2, 5 e 50 apostas) e com **rollback real provocado** no fluxo da WIN (falha após o flush → nada persistido), com saldo, transações, ledger e outbox conferidos por SQL após cada cenário.
- [x] Ledger append-only. — imutabilidade de domínio + trigger `wallet_ledger_immutable` exercitado por teste (UPDATE/DELETE rejeitados).
- [~] LOSS não altera saldo. — **domínio**: `affectsBalance()` `false` e
      `ledgerDirectionFor()` que lança ("LOSS does not generate ledger
      entries"), testados; **falta o caso de uso** que prove ausência de
      débito/crédito e de lançamento no saldo real.
- [~] REFUND e ROLLBACK não podem ser duplicados. — unicidade garantida no
      schema pelo índice parcial `wager_transactions_reversal_unique`
      (regra 4) + factories que exigem referência (regra 1); **sem caso de
      uso** que os dispare.
- [ ] Reconciliação entre saldo e ledger. — `isBalanced()` existe; sem endpoint/caso de uso.

## Concorrência — 20 pontos
- [x] Duas apostas de 80 com saldo 100: uma aprovada, outra rejeitada, saldo 20. — `concurrency.integration.e2e-spec.ts` (também com 5 apostas concorrentes).
- [x] Sem lost updates ou saldo negativo. — risco eliminatório 2; 2, 5 e 50 apostas concorrentes sem saldo negativo nem débito duplicado.
- [x] Carteiras distintas processam em paralelo. — cenário "Carteiras distintas em paralelo" no mesmo arquivo.
- [ ] Testes com pelo menos três instâncias. — risco eliminatório 5, ainda não testado (os testes existentes concorrem dentro de um processo).

## Idempotência — 15 pontos
- [x] 50 envios paralelos da mesma aposta geram um débito. — 1 transação, 1 débito, 49 replays; verificado por SQL em PostgreSQL real.
- [x] Idempotência persistida no PostgreSQL. — colunas + gravação; replay e conflito verificados sob concorrência em banco real.
- [x] Mesma chave/payload retorna resultado original. — `replayed: true` em 49 de 50 requisições concorrentes.
- [x] Payload diferente com mesma chave gera conflito. — `IDEMPOTENCY_PAYLOAD_CONFLICT` na mesma wallet e entre wallets distintas (esta última exigiu correção: o erro cru de unique vazava). O `payloadHash` agora inclui `kind` e usa chaves ordenadas (README §9), então tipos diferentes na mesma chave são conflito — provado em `payload-hash.spec.ts`.
- [ ] Garantia sobrevive a reinícios. — não testado.

## Mensageria — 15 pontos
- [x] Inbox persistente. — `InboxMessage` (§6.5) + `InboxMessageRepository`,
      unique `(consumer_name, message_id)` no banco; redelivery e duas cópias
      da mesma mensagem não geram efeito novo (`wager-command-consumer.integration`).
- [x] Outbox atômica com a operação. — gravada na mesma transação dos efeitos;
      o rollback real comprova que nada sobra (`win.integration:770`,
      `outbox-publisher.integration` cenário 5) e há worker de publicação.
- [x] Eventos publicados somente após commit. — risco eliminatório 6 atendido:
      o publisher só lê linhas já confirmadas e o teste de rollback comprova
      que a transação desfeita não gera publicação.
- [x] Redelivery não duplica efeitos. — Inbox por `(consumerName, messageId)`;
      reentrega após queda entre commit e ack não repete débito nem transação.
- [x] Retries, backoff e DLQ testados. — **outbox**: retentativa limitada (10)
      com backoff `5 s × 2^(n−1)` (teto 15 min); **consumidor**: reentrega por
      visibilidade do SQS para transitórios e DLQ para permanentes, com
      `maxReceiveCount` levando à DLQ quando o limite vence — tudo em
      PostgreSQL + LocalStack reais.
- [x] ACK somente após persistência durável. — `DeleteMessage` só depois do
      commit; a queda entre commit e ack é recuperada por outra instância sem
      duplicar efeitos.
- [~] Crash e reinício recuperáveis. — queda entre commit e ack (com
      recuperação) e falha de processamento (sem efeito parcial) cobertas; o
      **reinício do processo** em si não é testado.
- [x] Referências atrasadas são recuperadas (§7.1). — captura da
      `ProcessWinUseCase` (`PENDING_REFERENCE` + evento `WagerTransactionPendingReference`,
      replay não resolve) **mais** o worker da Fase 13:
      `ResolvePendingReferencesUseCase` com backoff exponencial (5 s × 2^(n−1),
      teto 15 min), 10 tentativas e TTL absoluto de 6 h — ambos os limites
      verificados independentemente (`shouldRejectMissingReference` = tentativas
      **ou** TTL), claim com `FOR UPDATE SKIP LOCKED`, bump da tentativa durante
      o claim, e esgotado o limite **ou** vencido o TTL → `REJECTED` +
      `REFERENCE_NOT_FOUND` + `WagerTransactionRejected` na mesma transação.
      Linha sem referência/provider/rodada **ou** com player/moeda divergentes
      da wallet → `FAILED` + `INTERNAL_ERROR`
      (inconsistência de estado persistido, nunca `REFERENCE_NOT_FOUND`);
      `resolveReference` descarta a própria linha, então uma WIN
      auto-referenciada é referência ausente e termina pela §7.1 em vez de
      creditar a si mesma. 15 unitários do caso de uso (11 da Fase 13 + 4 das
      correções da auditoria), 12 do worker e 10 cenários de integração em
      PostgreSQL real (referência
      tardia, limite, TTL, backoff, 2 instâncias na mesma linha, lote 4×2
      workers, crash antes/depois do commit, replay terminal, auto-referência
      e vínculo wallet ↔ transação corrompido).
- [x] Publicação dos quatro eventos exigidos. — `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` são gravados na outbox (o `data` dos três primeiros é decisão do projeto — o README §11 só define o de `WalletBalanceChanged`) e **todos são publicados**: o teste `publica os quatro tipos de evento exigidos pela §11` confere os quatro `eventType` na mensagem recebida do SQS.

## Arquitetura — 10 pontos
- [x] Domínio independente de NestJS, SQS e ORM. — `src/domain/` não importa infraestrutura.
- [~] HTTP e worker compartilham os casos de uso. — **worker sim**: o
      `PendingReferenceWorker` é apenas agendamento/log e delega tudo ao
      `ResolvePendingReferencesUseCase`, como o `ProcessWinUseCase` é
      chamado pela camada que existir. **HTTP não**: nenhum endpoint está
      registrado.
- [x] OPENING não pode ser submetido externamente. — factory `createOpening` exclui estruturalmente metadados de provedor; CHECK `wager_transactions_opening_internal`.
- [~] Regras de provedor e referência validadas. — **domínio**: factories
      validam campos de provedor/idempotência obrigatórios, limites de
      coluna, `roundId`/`gameId`, valor positivo e a política de referência
      por kind (exigida em REFUND/ROLLBACK, opcional em WIN, proibida em
      BET/LOSS), com testes de limites; unicidade da reversão no schema.
      **Aplicação**: o `ProcessBetUseCase` constrói a BET pela factory
      `createBet` e exige `roundId`/`gameId`
      (`INVALID_ROUNDID`/`INVALID_GAMEID`); o `ProcessWinUseCase` aplica a
      **regra 2** — resolve por `(providerId, referenceExternalTransactionId)`,
      sem aceitar a própria linha como alvo, e confere player, moeda,
      rodada e wallet, com
      `REJECTED + REFERENCE_MISMATCH` em cada divergência (5 casos
      testados) e `PENDING_REFERENCE` quando o alvo não existe — tudo
      validado antes de tocar o banco. **Falta**: igualdade de valor
      (regra 5, das reversões) e mapeamento HTTP.

## Testes — 10 pontos
- [x] Testes unitários e de integração. — 248 unitários + 81 de integração (8 PostgreSQL + 8 concorrência + 10 WIN + 10 referência pendente + 7 outbox + 6 consumo de comandos + 4 SQS + 16 HTTP + 12 reversões).
- [x] PostgreSQL e SQS reais nos testes de integração. — `compose.integration.yaml`; sem mocks nessa suíte.
- [~] Migrations e constraints verificadas. — duas constraints, rollback e trigger de append-only verificados; `up` **e** `down` da `Migration20261024150000_PendingReferenceRetry` executados no banco de integração (colunas/índices/CHECK saem e voltam); `down` da migration inicial continua não executado.
- [~] Concorrência, reinício e publishers concorrentes testados. — concorrência entre transações/conexões testada em PostgreSQL real, **mais duas instâncias do worker de §7.1** drenando o mesmo lote com um único crédito por linha, **dois publishers concorrentes sobre a mesma outbox** (claim único por mensagem e nenhuma perdida — `outbox-publisher.integration.e2e-spec.ts`) e **três consumidores concorrentes** processando comandos sem duplicar nem perder (`wager-command-consumer.integration.e2e-spec.ts`). Entrega "exatamente uma vez" **não** é o que esses cenários comprovam: a garantia vem da Inbox persistente, da unique de idempotência e da atomicidade. **Reinício do processo** não testado (a queda entre commit e ack é recuperada por outra instância).

## Observabilidade — 5 pontos
- [ ] Logs JSON sem segredos. — não implementado.
- [ ] Métricas operacionais. — não implementado.
- [ ] Liveness e readiness separados. — não implementado.

## Documentação — 5 pontos
- [x] README reproduzível. — comandos de ambientes e testes documentados.
- [x] Variáveis de exemplo sem segredos reais. — `.env.example`, `.env.integration.example` (apenas valores ilustrativos).
- [x] Trade-offs e limitações documentados. — `ARCHITECTURE.md` e `PROGRESS.md`.

## Pendências que travam a entrega
1. Nada está commitado desde a fundação (bloqueia "Revisar Git").
2. `WalletRepository.create` cria wallet sem os registros financeiros
   obrigatórios e fora de transação — caminho inseguro pendente de decisão.
3. `bun run test:e2e` falha por problema conhecido de configuração do
   scaffold NestJS (enums em strip-only mode do Node 24).
4. LOSS, REFUND e ROLLBACK: domínio pronto (factories, transições e
   `FailureCode`, com testes), mas **sem casos de uso** nem HTTP. A **WIN**
   foi concluída na Fase 12 (`ProcessWinUseCase`, com a política de
   referência implementada e testada — `ARCHITECTURE.md`), restando os três
   kinds de reversão/resultado.
5. Múltiplas instâncias (≥3 processos) e publicação de eventos: sem teste — a
   concorrência entre transações/conexões e entre **duas instâncias do worker
   de §7.1** já está testada em PostgreSQL real.

> Resolvido na Fase 13: `PENDING_REFERENCE` **agora tem reprocessamento** —
> worker de §7.1 com backoff, 10 tentativas, TTL de 6 h, índices de
> varredura e `REFERENCE_NOT_FOUND` (ver acima, em "Mensageria").
