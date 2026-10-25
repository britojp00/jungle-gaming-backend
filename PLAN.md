# Plano de implementação — desafio Jungle Gaming

Legenda de status:
- `[x]` implementado **e** validado pelo critério da etapa.
- `[~]` **parcial** — implementado em parte, ou implementado mas sem a
  validação exigida pelo critério.
- `[ ]` pendente.

Validações executadas até agora estão registradas em `PROGRESS.md`. O estado
por requisito eliminatório está em `ACCEPTANCE_CHECKLIST.md`.

## Progresso atual
- [x] Verificar Bun, Docker, Docker Compose e Git.
- [x] Criar scaffold NestJS com TypeScript estrito.
- [x] Instalar dependências com Bun.
- [x] Validar build, testes unitários e lint.
- [x] Integrar o scaffold à raiz e remover a pasta temporária.
- [x] Registrar a fundação em commit.

> O histórico de versionamento está organizado em commits desde a entrega
> final (ver `PROGRESS.md`, seção "Situação do versionamento").

## Dia 1 — Infraestrutura e domínio financeiro
- [x] Criar Docker Compose para PostgreSQL e LocalStack.
      (`compose.yaml`; containers verificados em execução.)
- [~] Configurar MikroORM e migrations versionadas e reversíveis.
      MikroORM configurado e migrations aplicadas em banco real (hoje são
      quatro). `up` **e** `down` executados no banco de integração para
      `PendingReferenceRetry`, `ReversalUniqueProcessed` e
      `ReversalUniquePerReference`; a `down` da `InitialSchema` nunca foi
      executada.
- [x] Definir constraints e índices para as invariantes financeiras.
      (`Migration20261024021931_InitialSchema.ts`; duas delas verificadas por
      teste real: `wallets_balance_non_negative` e
      `wallets_player_currency_unique`.)
- [x] Implementar Money imutável, decimal exato e escala fixa de duas casas.
      (`src/domain/shared/value-objects/money.ts` + 15 testes unitários.)
- [x] Implementar Wallet, WagerTransaction e WalletLedgerEntry.
      As três classes existem e são testadas. `WagerTransaction` cobre as 6
      operações: `createOpening` (interna), `createBet`, `createWin`,
      `createLoss`, `createRefund`, `createRollback`, as transições de
      estado do README 6.3 (`markProcessed`, `markPendingReference`,
      `reject`, `fail`) e as consultas (`affectsBalance`, `requiresReference`,
      `matchesPayload`, `ledgerDirectionFor`).
- [x] Implementar abertura interna da carteira com OPENING e ledger atômicos.
      (`OpenWalletUseCase`; atomicidade verificada contra PostgreSQL real.)
- [x] Implementar BET, WIN, LOSS, REFUND e ROLLBACK conforme as regras oficiais.
      **Domínio completo** das cinco operações (factories com validação de
      campos, referências, valores e `FailureCode`, com testes de casos
      válidos, inválidos, limites e transições). Os **cinco casos de uso**
      existem (`ProcessBetUseCase`, `ProcessWinUseCase`, `ProcessLossUseCase`
      e `ProcessReversalUseCase` para `REFUND`/`ROLLBACK`), integrados ao
      domínio com validação antes do banco, `roundId`/`gameId` obrigatórios
      (`INVALID_ROUNDID`/`INVALID_GAMEID`), eventos na outbox e as regras do
      §7 aplicadas nas reversões (referência precisa estar `PROCESSED`,
      `REFUND` só reverte `BET`, igualdade de valor e no máximo **uma**
      reversão processada por referência — a disputa vira `REJECTED` de
      auditoria).
- [x] Garantir saldo, transação, ledger e outbox na mesma transação SQL.
      Vale para OPENING, BET e WIN, todos verificados em **PostgreSQL real**
      (cenários de concorrência, invariante saldo ⇄ ledger e **rollback
      real provocado**: um proxy no `EntityManager` falha após o `flush` da
      outbox e a suíte confere que saldo, ledger, transação e outbox foram
      desfeitos — `win.integration.e2e-spec.ts`).
- [x] Criar testes unitários para dinheiro e regras de domínio.
      (143 testes em 9 arquivos, incluindo regras de BET, WIN, LOSS, REFUND
      e ROLLBACK, transições de estado, hash canônico, o caso de uso de BET
      e o caso de uso de WIN com resolução de referência.)

**Aceite da fase:** build e testes passam ✓; dinheiro não usa ponto
flutuante ✓; saldo e ledger consistentes ✓ (OPENING em banco real); migrations
podem ser aplicadas ✓ e **revertidas — não verificado**.

## Dia 2 — API, idempotência, concorrência e mensageria
- [x] Implementar os contratos HTTP definidos no README oficial:
  - POST /wallets
  - GET /wallets/:walletId
  - GET /wallets/:walletId/ledger
  - POST /wallets/:walletId/reconciliation
  - POST /wagering/transactions
  - GET /wagering/transactions/:transactionId
  - GET /providers/:providerId/wagering/transactions/:externalTransactionId

  (mais `GET /health/live` e `GET /health/ready`; controllers sem regra
  financeira, reutilizando os casos de uso — `src/http/`, 16 testes de
  integração.)
- [x] Validar payloads, códigos HTTP e códigos de falha de negócio.
      A taxonomia `FailureCode` (README §7.2) está definida e documentada em
      `src/domain/wagering/failure-code.ts`; o **mapeamento HTTP** está
      fechado em `src/http` (400 payload inválido, 404, 409 conflito de
      idempotência/reversão, 422 rejeição de regra, 202 aceite pendente, 503
      transitória) — um único mapeamento para todos os endpoints (§9).
- [x] Implementar idempotência persistida com hash canônico do payload.
      Componente compartilhado `src/application/wagering/payload-hash.ts`:
      SHA-256 sobre JSON canônico com **chaves ordenadas** e **`kind`
      incluído** (README §9 — o `kind` faltava antes), algoritmo documentado
      em `README.md`, contrato de tipo que exclui o header, 9 testes
      unitários. Gravação em `payload_hash` e conflito verificados sob
      concorrência real em PostgreSQL **depois** da troca do algoritmo
      (replay 50×, conflito na mesma wallet e entre wallets distintas).
- [x] Garantir replay com a resposta original e conflito para payload diferente.
      Implementado para BET (`replayed: true` e `IDEMPOTENCY_PAYLOAD_CONFLICT`)
      e verificado em PostgreSQL real sob concorrência
      (`test/integration/concurrency.integration.e2e-spec.ts`).
- [x] Implementar concorrência por carteira no PostgreSQL, sem locks em memória.
      Lock pessimista (`PESSIMISTIC_WRITE`) em
      `WalletRepository.findByIdForUpdate`, usado pelo `ProcessBetUseCase`;
      unique `wallets_player_currency_unique` validada sob corrida real de
      abertura. Verificado com 2, 5 e 50 apostas concorrentes na mesma wallet.
      **Entre processos independentes** verificado depois (2 processos;
      faltam ≥3 simultâneos e reinício).
- [x] Implementar inbox persistente e deduplicação de mensagens.
      `InboxMessage` (§6.5) + `InboxMessageRepository`, unique
      `(consumer_name, message_id)` no banco; duplicatas e redelivery não
      geram efeito novo.
- [x] Implementar outbox transacional e publishers concorrentes.
      Gravação atômica nos casos de uso + `OutboxPublisherWorker` com claim
      `FOR UPDATE SKIP LOCKED`, janela gravada antes de publicar, retentativas
      limitadas com backoff e desligamento gracioso — dois publishers
      concorrentes testados sem perder nem duplicar indefinidamente.
- [x] Provisionar filas SQS, DLQ e políticas de redrive no ambiente local.
      (`docker/localstack/init-queues.sh` em dev; fila de integração criada
      pela própria suíte. Existência verificada no LocalStack real.)
- [x] Implementar o consumidor SQS reutilizando os casos de uso HTTP.
      `WagerCommandConsumerWorker` + `ReceiveWagerTransactionUseCase`
      despacham para os mesmos casos de uso da entrada HTTP (§10).
- [x] Garantir ACK somente após commit durável.
      `DeleteMessage` só depois do commit; queda entre commit e ack é
      recuperada por outra instância (inclusive em processo distinto) sem
      duplicar efeitos.
- [x] Implementar retries com backoff e recuperação de referências pendentes.
      Backoff `5 s × 2^(n−1)` (teto 15 min), 10 tentativas e TTL de 6 h
      (§7.1); reentrega por visibilidade para transitórios e DLQ para
      permanentes (`maxReceiveCount`).
- [x] Publicar os eventos exigidos:
  - WagerTransactionProcessed — publicado
  - WagerTransactionRejected — publicado
  - WalletBalanceChanged — publicado
  - WagerTransactionPendingReference — publicado

  (os quatro `eventType` são conferidos na mensagem recebida do SQS em
  `outbox-publisher.integration.e2e-spec.ts`.)

**Aceite da fase:** 50 requisições paralelas idênticas geram um único efeito
financeiro — **verificado em PostgreSQL real**; duas apostas de 80,00 contra
saldo 100,00 resultam em uma aprovação e saldo 20,00 — **verificado em
PostgreSQL real**; eventos só são publicados após commit — **verificado**
(teste de rollback comprova que a transação desfeita não gera publicação).

## Dia 3 — Resiliência, testes e entrega
- [~] Executar a aplicação em pelo menos três instâncias/processos.
      Dois processos independentes (`bun`, conexões próprias, largada
      simultânea) já concorrem sobre o mesmo banco
      (`test/integration/multi-process.integration.e2e-spec.ts`); **≥3
      processos simultâneos e reinício do serviço** continuam pendentes.
- [x] Testar concorrência na mesma carteira e paralelismo entre carteiras distintas.
      (`concurrency.integration.e2e-spec.ts`: 2 e 5 apostas de 80,00 sobre
      100,00, 50 envios idênticos e apostas em carteiras distintas em paralelo,
      todas contra PostgreSQL real com estado persistido verificado por SQL.)
- [~] Testar duplicação, conflito de idempotência e reinícios.
      Duplicação (50×) e conflito (mesma wallet e entre wallets distintas)
      verificados em PostgreSQL real. **Reinício do processo não testado.**
- [x] Testar falha após commit e antes do ACK SQS.
      (`wager-command-consumer.integration` e, entre processos, o cenário de
      redelivery de `multi-process.integration.e2e-spec.ts`.)
- [x] Testar recuperação da outbox e publishers concorrentes.
      (`outbox-publisher.integration.e2e-spec.ts`: queda antes/depois do
      commit, dois publishers concorrentes, retentativa e os quatro eventos.)
- [~] Testar redelivery, retries, backoff, DLQ e encerramento SIGTERM.
      Redelivery, retries, backoff e DLQ testados em PostgreSQL + LocalStack
      reais (inclusive redelivery entre processos); o desligamento gracioso
      está implementado (shutdown hooks + ciclo em andamento aguardado), mas
      **SIGTERM em si não é testado**.
- [x] Testar referências recebidas fora de ordem e limite de tentativas.
      (`pending-reference.integration.e2e-spec.ts`: 10 cenários, incluindo
      referência tardia, esgotamento das 10 tentativas e TTL.)
- [~] Validar constraints, migrations e ledger append-only.
      Duas constraints, o rollback e o trigger `wallet_ledger_immutable`
      (UPDATE e DELETE rejeitados) verificados em banco real. `up` **e** `down`
      conferidos para `PendingReferenceRetry` e as duas migrations de reversão;
      **`down` da migration inicial não executada**.
- [x] Implementar reconciliação entre saldo persistido e ledger.
      (`ReconcileWalletUseCase` + `POST /wallets/:walletId/reconciliation`;
      acusa divergência sem alterar dados, testado com saldo corrompido.)
- [~] Implementar logs JSON, métricas e liveness/readiness.
      **Liveness e readiness prontos** (`/health/live`, `/health/ready`);
      logs JSON estruturados e métricas operacionais (§12) continuam
      pendentes.
- [x] Documentar arquitetura, trade-offs, variáveis e comandos reproduzíveis.
      (`README.md`, `ARCHITECTURE.md`, `PROGRESS.md`, `.env.example`,
      `.env.integration.example`.)
- [x] Executar testes unitários e de integração com PostgreSQL e SQS reais em containers.
      Harness pronto e suíte passando (258 unitários + 92 de integração),
      incluindo concorrência real em PostgreSQL, publicação/consumo com SQS
      real e concorrência entre **processos independentes**.
- [x] Revisar Git e confirmar que não há segredos versionados.
      Histórico organizado em commits com arquivos explicitamente
      selecionados; nenhum segredo, credencial real ou artefato temporário
      versionado.

**Aceite da fase:** invariantes financeiras preservadas sob concorrência e
duplicação — **demonstrado em PostgreSQL real**; sob falhas e redelivery
(inclusive entre processos) — **demonstrado**; sob reinício do serviço —
**não demonstrado**; testes reproduzíveis — sim; documentação completa —
nesta etapa.

## Infraestrutura de testes de integração (disponível)
- [x] Ambiente Docker isolado (`compose.integration.yaml`): PostgreSQL em
      `127.0.0.1:5433` e LocalStack em `127.0.0.1:4567`, containers e volumes
      próprios, portas em loopback.
- [x] Harness em `test/integration/support/` com bootstrap do MikroORM,
      migrations aplicadas somente no banco `_integration` e truncate entre testes.
- [x] Trava de segurança que recusa banco sem sufixo `_integration`, antes de
      conectar ou apagar dados.
- [x] Comando `bun run test:integration` (config própria em
      `vitest.config.integration.ts`, execução em série).
- [x] Testes reais de rollback, constraints do PostgreSQL,
      `OpenWalletUseCase` atômico e existência/criação de fila SQS.
- [x] Testes de concorrência reais (`test/integration/concurrency.integration.e2e-spec.ts`):
      apostas simultâneas na mesma wallet (2, 5 e 50), replay e conflito de
      idempotência, abertura concorrente de wallet e carteiras distintas em
      paralelo — todos contra PostgreSQL real, com saldo, transações, ledger e
      outbox verificados por SQL cru após cada cenário.

Ainda pendente nesta frente:
- [~] Concorrência entre múltiplas INSTÂNCIAS (processos) contra o mesmo banco —
      **2 processos independentes** já concorrem
      (`test/integration/multi-process.integration.e2e-spec.ts`); faltam
      **≥3 processos simultâneos** e **reinício do serviço**.
- [~] Reversão de migrations (`down`) verificada em banco real — `up`/`down`
      conferidos em três das quatro migrations; falta a `down` da
      `Migration20261024021931_InitialSchema`.
- [ ] Corrigir `bun run test:e2e` (scaffold NestJS carrega enums em
      strip-only mode do Node 24 e falha; causa e correção conhecidas, registradas
      em `PROGRESS.md`).

## Decisão registrada — política de referência do `WIN`
Resolvida nesta etapa, **antes** de implementar WIN/LOSS/REFUND/ROLLBACK.
Análise completa com citações em `ARCHITECTURE.md` (seção "Decisão —
política de referência do `WIN`").

- **Decisão:** `WIN` **com** `referenceExternalTransactionId` cujo alvo
  `(providerId, referenceExternalTransactionId)` ainda não existe é
  persistida como `PENDING_REFERENCE` (regra 8 + §7.1, regras **sem
  qualificação de kind**) e reprocessada por worker agendado; esgotado o
  limite → `REJECTED` + `REFERENCE_NOT_FOUND` + evento. `WIN` **sem**
  referência aplica imediatamente (tabela §7: `WIN | crédito`;
  `requiresReference()` só para REFUND/ROLLBACK). Alvo **existente**
  resolve na hora (regra 2 não condiciona status); alvo existente em
  violação da regra 2 → `REJECTED` + `REFERENCE_MISMATCH`.
- **Classificação:** o README não nomeia o `WIN` no fluxo de referência
  atrasada — trata-se de **decisão de projeto sobre texto não qualificado**,
  escolhida por **não inventar exceção** à regra 8 (a alternativa exigiria
  uma exceção que o contrato não estabelece, e trataria a opcionalidade da
  presença como permissão de ignorar uma referência declarada, contra a
  regra 2). Interpretada como manda o próprio §7: "qualquer interpretação
  adicional adotada deve ser documentada".
- **Justificativa:** preserva a causalidade do §3 ("uma operação
  dependente pode chegar antes da operação referenciada"), mantém toda
  referência declarada com destino definido (resolver ou esgotar →
  `REJECTED`), e usa mecanismos que o contrato já exige (evento
  `WagerTransactionPendingReference`, resposta "aceite com processamento
  pendente").
- **Consequências para o caso de uso:** o `ProcessWinUseCase` terá duas
  rotas — crédito imediato (modelo: `ProcessBetUseCase`) e aceite
  pendente, esta com evento novo na outbox (`WagerTransactionPendingReference`,
  criado na Fase 12) e sem `WalletBalanceChanged`; replay devolve o
  estado armazenado sem resolver; lock de wallet vale nas duas rotas;
  igualdade de valor e pertinência da referência são responsabilidade do
  caso de uso. **Schema comporta a decisão sem migration** (CHECK e
  FK verificadas na migration); as duas pendências registradas para a etapa
  do worker — colunas de tentativas/backoff e índice de varredura sobre
  `reference_external_transaction_id` — foram resolvidas na **Fase 13**
  pela `Migration20261024150000_PendingReferenceRetry`. O **valor** do
  limite/TTL, delegação explícita do §7.1, foi definido e justificado junto
  com o worker: 10 tentativas (≈ 51 min) + TTL absoluto de 6 h.

## Próxima sequência recomendada

**Estado atual:** concluídos os itens **1** (histórico de commits), **3**
(LOSS/REFUND/ROLLBACK), **4** (worker de outbox + publisher), **5** (camada
HTTP), **7** (Inbox, retries, backoff e DLQ do consumidor) e a
**reconciliação** de 8, além de os testes entre **processos independentes**
terem entrado na frente de **6**. Seguem pendentes: **2**
(`WalletRepository.create`), o restante de **6** (≥3 processos simultâneos e
reinício do serviço) e a **observabilidade** (§12). Ordem por dependência —
cada etapa destrava a seguinte:

1. **Decidir o destino de `WalletRepository.create`** (remover ou tornar
   transacional). É um caminho inseguro que pode ser chamado por engano.
2. **Testes com ≥3 processos/instâncias simultâneos** e com **reinício do
   serviço** — encerra a frente de concorrência e idempotência (os testes com
   2 processos independentes já cobrem §8, corrida de reversão e redelivery
   após commit).
3. **Observabilidade (§12)** — logs JSON estruturados com IDs de correlação e
   métricas operacionais.
4. **Consumidor da fila de eventos** da outbox (§11, passo 5) — quem torna a
   duplicata de publicação segura do lado dos eventos.
5. **Corrigir `bun run test:e2e`** (configuração do scaffold NestJS).

## Prioridades de avaliação
1. Correção financeira — 20 pontos.
2. Concorrência — 20 pontos.
3. Idempotência — 15 pontos.
4. Mensageria e falhas — 15 pontos.
5. Arquitetura — 10 pontos.
6. Testes — 10 pontos.
7. Observabilidade — 5 pontos.
8. Documentação — 5 pontos.

## Decisões de escopo
- Não implementar autenticação artesanal.
- Autenticação é opcional; documentar a decisão e o ponto de extensão.
- Priorizar invariantes financeiras, testes reais e recuperação de falhas.
- Não prometer exactly-once entre PostgreSQL e SQS.
- Consultar o README oficial antes de decidir detalhes não especificados aqui.

Referência oficial: https://github.com/junglegaming/backend-challenge
