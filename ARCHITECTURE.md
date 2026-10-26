# Arquitetura — Jungle Gaming Backend

Este documento descreve **o que está implementado** e **o que está apenas
planejado**, separados explicitamente. O estado por fase fica em `PLAN.md`, o
estado por requisito em `ACCEPTANCE_CHECKLIST.md` e a cronologia em
`PROGRESS.md`.

## Stack
Bun 1.x, TypeScript estrito, NestJS, PostgreSQL, MikroORM, AWS SQS, LocalStack e Docker Compose.

### Uso real de Bun, Node e Vitest (§4)
O requisito oficial pede Bun 1.x como runtime, package manager e test runner;
o uso real do projeto, sem maquiagem:

- **Bun** — gerenciamento de pacotes e execução de scripts (`bun install`,
  `bun run …`), mais o runtime das migrations (`bun --bun run migration:up`)
  e dos processos dos testes multiprocesso (TypeScript com `enum`, que o modo
  strip-only do Node não carrega);
- **Node** — runtime do **comando de produção**: `bun run start:prod` executa
  `node dist/main` (`start:dev` roda via `nest start`, também Node);
- **Vitest** — **test runner** da suíte, sobre processos Node
  (`bun run test`, `bun run test:integration`).

Ou seja: Bun gerencia pacotes e scripts; **a aplicação em produção roda em
Node e os testes rodam sob Vitest**. A divergência em relação ao runtime
exigido pelo §4 é assumida e registrada aqui e no `README.md`.

---

# 1. Implementado

## Estrutura de diretórios
```
src/
  domain/                          # sem dependência de NestJS, ORM ou SQS
    shared/value-objects/money.ts  # + money.spec.ts
    shared/errors/invalid-transaction-state-error.ts
    wallets/wallet.ts              # + wallet.spec.ts
    ledger/wallet-ledger-entry.ts  # + wallet-ledger-entry.spec.ts
    wagering/wager-transaction.ts  # + wager-transaction.spec.ts
    wagering/failure-code.ts       # taxonomia README §7.2
  application/
    wallets/use-cases/open-wallet.use-case.ts     # + spec
    wagering/use-cases/process-bet.use-case.ts    # + spec
    wagering/use-cases/process-win.use-case.ts    # + spec
    wagering/use-cases/resolve-pending-references.use-case.ts # + spec (§7.1)
    wagering/process-support.ts                   # máquina compartilhada BET/WIN
    wagering/reference-retry-policy.ts            # + spec (backoff/TTL §7.1)
    wagering/payload-hash.ts                      # + spec (hash canônico)
  infrastructure/persistence/
    entities/      # wallet, wager-transaction, wallet-ledger-entry, outbox-message, inbox-message
    repositories/  # wallet, wallet-ledger, wager-transaction
  infrastructure/workers/pending-reference.worker.ts  # + spec (§7.1)
  migrations/
    Migration20261024021931_InitialSchema.ts
    Migration20261024150000_PendingReferenceRetry.ts
  mikro-orm.config.ts
  app.module.ts
test/
  support/fake-entity-manager.ts                 # fake de unitário
  integration/                                   # serviços reais
    support/{env,orm,sqs}.ts
    postgres.integration.e2e-spec.ts
    concurrency.integration.e2e-spec.ts
    win.integration.e2e-spec.ts
    pending-reference.integration.e2e-spec.ts
    sqs.integration.e2e-spec.ts
  app.e2e-spec.ts                                # scaffold NestJS (ver §4)
```

## Domínio

### `Money` (`src/domain/shared/value-objects/money.ts`)
Imutável, sem estado mutável, independente de NestJS/ORM. **Nunca usa `number`
para dinheiro**: entrada e serialização são strings decimais de duas casas via
`MoneyProps` (`{ amount, currency }`).

- `Money.from` valida o formato com `^(0|[1-9]\d*)\.\d{2}$` — rejeita escala
  inválida (`1.5`, `1.000`), zeros à esquerda e valores negativos na entrada.
- Faixa compatível com `numeric(20,2)`: no máximo 18 dígitos inteiros e 2
  decimais, máximo `999999999999999999.99`. Validada **na própria string**,
  antes de qualquer conversão, e novamente em `Money.create` para a aritmética.
- `Money.create` rejeita qualquer magnitude `>= 10^18`: um estouro vira erro de
  domínio, nunca saldo arredondado em silêncio.
- Moeda explícita e obrigatória (`^[A-Z]{3}$`); operações entre moedas
  distintas lançam `Currency mismatch`.

### Precisão do decimal.js — verificação empírica
O decimal.js **não arredonda na construção** a partir de string, mas
**arredonda o resultado de `plus`/`minus`** para a precisão configurada
(padrão: 20 dígitos significativos). Comprovado em teste:
`999999999999999999.99 + 999999999999999999.99` devolveria
`2000000000000000000.00`, perdendo centavos e dígitos inteiros.

`Money` fixa `Decimal.set({ precision: 21 })` — a menor precisão compatível
com `numeric(20,2)`: 20 dígitos para o maior valor válido, mais 1 para o carry
da soma. Assim a validação de faixa rejeita o estouro usando o valor
verdadeiro. `Money` é o único consumidor de decimal.js no projeto.

### `Wallet` (`src/domain/wallets/wallet.ts`)
Saldo (`Money`) + versão (`version`). `create` nasce em `version = 1`.
`credit`/`debit` exigem valor positão e data válida, incrementam a versão e
`debit` recusa saldo negativo.

### `WalletLedgerEntry` (`src/domain/ledger/wallet-ledger-entry.ts`)
Lançamento imutável (construtor privado, sem métodos de transição).
`create` valida: direção, valor positivo, saldos não negativos, moeda única e
a aritmética `balanceBefore ± money === balanceAfter`. `rehydrate` reconstrói
sem revalidar (README 6.0). `isBalanced()` retorna `false` (não lança) em
divergência de moeda, para permanecer uma consulta total de reconciliação.

### `WagerTransaction` (`src/domain/wagering/wager-transaction.ts`)
Enums `WagerTransactionKind` (os 6 tipos do README) e `WagerTransactionStatus`.

**Factories** — cada operação tem a sua, com as garantias do README 6.3
estruturalmente no tipo (uma `REFUND` sequer é construível sem referência):

| Factory | Status inicial | Referência externa | Efeito |
|---|---|---|---|
| `createOpening` | `PROCESSED` | não | interna: sem metadados de provedor, sem `roundId`/`gameId` |
| `createBet` | `PENDING` | proibida | débito |
| `createWin` | `PENDING` | opcional (§7: "pode referenciar a BET") | crédito |
| `createLoss` | `PENDING` | proibida | informativa, `affectsBalance() === false` |
| `createRefund` | `PENDING` | obrigatória (regra 1) | crédito |
| `createRollback` | `PENDING` | obrigatória (regra 1) | inverte a direção da referência |

Validações comuns às operações de provedor: campos obrigatórios não vazios;
limites das colunas (`provider_id` 100, demais 255); `payload_hash` com 64
caracteres hexadecimais minúsculos; `roundId` e `gameId` obrigatórios
(README 6.3 + §3 "operações associadas a uma rodada" — o schema os deixa
anuláveis, o domínio é deliberadamente mais estrito); valor **estritamente
positivo** em todos os kinds (o ledger exige `amount > 0`; o schema aceita
`>= 0`).

**Transições** (README 6.3), sempre a partir de `PENDING` ou
`PENDING_REFERENCE`:

| Transição | Método |
|---|---|
| → `PROCESSED` | `markProcessed(referenceTransactionId?, at)` |
| → `PENDING_REFERENCE` | `markPendingReference()` — repetir é no-op idempotente |
| → `REJECTED` | `reject(code)` |
| → `FAILED` | `fail(code)` |

Qualquer transição a partir de `PROCESSED`, `REJECTED` ou `FAILED` lança
`InvalidTransactionStateError` (`src/domain/shared/errors/`) — erro de
programação, não caminho de negócio. `OPENING` nasce terminal, então nenhuma
transição lhe cabe. `processedAt` só é preenchido por `markProcessed`, tal
como na assinatura oficial.

**Consultas de domínio:** `affectsBalance()` (`false` somente para `LOSS`),
`requiresReference()` (REFUND/ROLLBACK), `matchesPayload()` (replay só com
payload idêntico) e `ledgerDirectionFor(reference?)` — `BET` → DEBIT;
`WIN`/`REFUND`/`OPENING` → CREDIT; `LOSS` lança erro (não gera lançamento,
README 6.4); `ROLLBACK` inverte a direção da referência, que precisa existir
e ser `BET`, `WIN` ou `REFUND` (regra 3).

`OPENING` nasce `PROCESSED` com `processedAt = createdAt`, derivado do README
6.3 + 9: é criada na mesma transação SQL da wallet e do ledger, portanto já
nasce aplicada, e sendo interna não haveria worker a processá-la depois.

**Interpretações adotadas** (README §7: "qualquer interpretação adicional
adotada deve ser documentada"):
- `LOSS` exige valor positivo: ele descreve a rodada perdida; o schema aceita
  `>= 0`, o domínio é mais estrito.
- Referência **proibida** em `BET`/`LOSS`: nenhuma regra do README lhe
  atribui significado; o schema aceitaria, o domínio recusa a combinação.
- A **presença** da referência (regra 1) é validada na factory; a
  **unicidade** da reversão (regra 4) é garantida no banco pelo índice
  parcial `wager_transactions_reversal_unique`, e a **igualdade de valor**
  (regra 5) pertence ao caso de uso — só ele vê a transação referenciada.
- `roundId`/`gameId` não existem em `OPENING`: a §3 trata de operações
  **enviadas por provedores**; OPENING é interna (§6.3).
- Campos de replay (`result_balance_*`) não entram no modelo de domínio,
  tal como no esqueleto oficial: são persistência do caso de uso (regra 7).

#### Decisão — política de referência do `WIN`
Registrada antes de implementar qualquer caso de uso de `WIN`/`LOSS`/
`REFUND`/`ROLLBACK`, conforme o §7: "qualquer interpretação adicional
adotada deve ser documentada".

**Requisitos explícitos do README (o texto, sem acréscimos):**

| Trecho | O que estabelece |
|---|---|
| §7, tabela | `WIN` "**pode** referenciar a `BET` da mesma rodada" — referência **opcional** no payload |
| §7, regra 1 | exige `referenceExternalTransactionId` **somente** em `REFUND`/`ROLLBACK` |
| 6.3 | `requiresReference()` — "true para **REFUND e ROLLBACK**" |
| §7, regra 8 | "**Referência ausente** → persistir como `PENDING_REFERENCE` e reprocessar depois (ver 7.1)" — **nenhum kind é nomeado** (as regras 1, 3, 4 e 5 nomeiam) |
| §7.1 | worker agendado com backoff exponencial; "limite de tentativas ou TTL **definido e justificado por você**"; esgotado → `REJECTED` com `failureCode` da referência inexistente, e evento correspondente publicado |
| §3 | "uma operação **dependente** pode chegar antes da operação referenciada" (premissa genérica, sem kind) |
| 6.3 | `PENDING_REFERENCE` = "aguardando a transação referenciada" — status sem restrição de kind |
| §7, regra 2 | a referência "**é resolvida** por `(providerId, referenceExternalTransactionId)`" e deve pertencer ao mesmo provider, player, wallet, moeda e rodada — critério só de chave, **sem condição de status** |
| §11 | evento `WagerTransactionPendingReference` — "referência ausente" |
| §9 | a resposta deve distinguir "aceite com processamento pendente" |

**Ambiguidade e classificação honesta:** o README não contém uma frase que
nomeie o `WIN` no fluxo de referência atrasada. A decisão abaixo aplica as
regras 8 e §7.1 **literalmente, como regras sem qualificação de kind** —
logo, é uma **decisão de projeto sobre texto não qualificado**, não uma
exigência textual que nomeie o `WIN`. A alternativa (creditá-lo
imediatamente) exigiria **inventar** uma exceção à regra 8 que o contrato
não estabelece, e trataria a *opcionalidade da presença* da referência
como *permissão de ignorar uma referência declarada* — contrariando a
regra 2 ("**é** resolvida"). Observação de auditoria: o §13, item 7, lista
entre os testes obrigatórios apenas "`ROLLBACK` ou `REFUND` entregue antes
da referência"; é uma lista de testes **mínimos**, não uma taxonomia de
comportamentos — não nomear `WIN` ali não proíbe o comportamento, e a
cobertura de `WIN` fora de ordem entrará nos testes do caso de uso.

**Decisão adotada:**

1. `WIN` **sem** `referenceExternalTransactionId` → aplica imediatamente
   (`PENDING → PROCESSED`, crédito, 1 `CREDIT`). A leitura hiper-literal da
   regra 8 — toda `WIN` "sem referência" viraria `PENDING_REFERENCE` e
   morreria no limite — se **autocontradiz** com a própria tabela §7
   (`WIN | crédito`) e está descartada pelo contrato.
2. `WIN` **com** referência cujo alvo `(providerId,
   referenceExternalTransactionId)` **ainda não existe** →
   `markPendingReference()`: persiste `PENDING_REFERENCE`, grava
   `WagerTransactionPendingReference` na mesma transação SQL (§11), sem
   saldo nem ledger, e devolve "aceite com processamento pendente" (§9).
3. Alvo **existe** (qualquer status) → resolve e credita, preenchendo
   `referenceTransactionId` no `markProcessed`. O critério é **existência**,
   por texto da regra 2 (sem condição de status) e de §7.1 (a falha é da
   referência "**inexistente**"). Consequência assumida e documentada: a
   `WIN` pode resolver contra uma `BET` `REJECTED` — o README só exige
   `BET` `PROCESSED` para `REFUND` (tabela §7); estender exigiria inventar
   regra.
4. Alvo existe mas **viola a regra 2** (outro provider/player/wallet/moeda/
   rodada) → `REJECTED` + `REFERENCE_MISMATCH`: divergência de identidade
   não se corrige esperando.
5. Reprocessamento: worker agendado com backoff (§7.1); esgotado o limite →
   `REJECTED` + `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
   O **valor** do limite/TTL é **delegado explicitamente pelo README** e foi
   definido e justificado na etapa do worker (10 tentativas + TTL de 6 h —
   ver "Worker de referências pendentes" abaixo).
6. Replay de uma `WIN` ainda pendente → devolve o resultado original
   armazenado (regra 7 + §9), **sem** resolver; a resolução é tarefa do
   worker (§7.1), não da reentrada.

**Consequências para o caso de uso `ProcessWinUseCase` (etapa seguinte):**
- **Duas rotas**: creditar (modelado no `ProcessBetUseCase`) e a rota de
  aceite pendente — esta exige o evento `WagerTransactionPendingReference`
  (criado na Fase 12) e retorno `PENDING_REFERENCE` sem
  `WalletBalanceChanged`.
- O lock da wallet permanece como unidade de concorrência (§8) nas duas
  rotas: decisão de implementação para uniformizar com a `BET`.
- Resolver a referência exige **ler** a transação referenciada — daí a
  igualdade de valor (regra 5) e a pertinência (regra 2) pertencerem ao
  caso de uso, não à factory (já registrado acima).
- **Schema atual comporta a decisão** (verificado campo a campo na
  migration): a CHECK `wager_transactions_reversal_reference_required` só
  exige a referência **externa** em `REFUND`/`ROLLBACK` e **não** exige a
  FK interna, logo uma linha `PENDING_REFERENCE` com
  `reference_transaction_id` nulo é válida para qualquer kind; a unique
  parcial `wager_transactions_reversal_unique` cobre só
  `REFUND`/`ROLLBACK` (a regra 4 é de reversão), logo `WIN` com referência
  não sofre unicificação. **Nenhuma divergência concreta — nenhuma
  migration nesta etapa.**
- **Pendências de schema resolvidas na etapa do worker** (eram: colunas de
  tentativas/backoff e índice de varredura). A opção escolhida combina as
  duas coisas que o §7.1 admite — tentativas persistentes **e** TTL por
  `created_at` —, então a migration
  `Migration20261024150000_PendingReferenceRetry` acrescenta
  `reference_attempts` (com CHECK `>= 0`), `reference_next_attempt_at`, o
  índice parcial de elegibilidade e o índice de
  `reference_external_transaction_id` (fallback da resolução), tudo com
  `down()` reversível. Detalhamento e medições em "Worker de referências
  pendentes" abaixo.

### Taxonomia de falhas (`src/domain/wagering/failure-code.ts`)
README §7.2 ("a taxonomia é sua — defina-a e documente-a"). Cada código mapeia
uma regra explícita:

| `FailureCode` | Origem |
|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo (§7, tabela) |
| `INSUFFICIENT_BALANCE_FOR_REVERSAL` | reversão que deixaria saldo negativo (regra 9) — **distinto** do anterior, como a regra exige |
| `REFERENCE_NOT_FOUND` | `PENDING_REFERENCE` esgotada (§7.1) |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada (regra 2) |
| `INTERNAL_ERROR` | falha permanente de infraestrutura (`FAILED`, §6.3) |

Persistência: gravado em `wager_transactions.rejection_reason`, coluna já
existente — **nenhuma migration nova**, a troca de nome de coluna não
adicionaria semântica. O `ProcessBetUseCase` grava o valor do enum
(`FailureCode.INSUFFICIENT_FUNDS`): a representação persistida continua
sendo a string da coluna, sem literais duplicados no caso de uso.

## Escolha do ORM e estratégia transacional (README §4)
O §4 exige justificar a escolha do ORM, o mapeamento do `Money` e a
estratégia transacional:

- **ORM: MikroORM** (a opção preferencial do §4). Por quê: Unit of Work e
  Identity Map explícitos, `em.transactional()` para aninhar os casos de uso
  numa única transação, `LockMode` para o lock pessimista por wallet
  (`WalletRepository.findByIdForUpdate` → `SELECT … FOR UPDATE`), e
  migrations versionadas com `up()`/`down()` testados em banco real. Prisma
  está fora do escopo do desafio e TypeORM não foi necessário.
- **Mapeamento do `Money`:** valor e moeda em colunas separadas
  (`amount numeric(20,2)` + `currency`), representados como **string** nas
  entidades — nunca `number`/`float`. A leitura devolve `MoneyProps` e o
  domínio reidrata com `Money.from`, mantendo a representação exata (§6.1);
  o domínio não conhece tipos do ORM nem do NestJS.
- **Estratégia transacional:** **uma transação SQL por operação**
  (`em.transactional` com um `flush`), contendo transação + saldo + ledger +
  inbox + outbox — é a atomicidade exigida pela §11, provada por rollback
  real nos testes. A unidade de concorrência é a `walletId` (§8): o lock
  `FOR UPDATE` é **por wallet**, adquirido dentro dessa mesma transação —
  nunca um lock global. A invariante `balance == ledger` é reforçada por
  constraints e trigger no banco, não só em código (§5.9).

## Persistência e constraints (`src/migrations/Migration20261024021931_InitialSchema.ts`)
Colunas monetárias são sempre `numeric(20,2)` (nunca `float`/`double`).

Invariantes reforçadas no banco:
- `wallets_balance_non_negative` (`balance >= 0`), `wallets_version_positive`
- `wallets_player_currency_unique` — **garantia real** contra carteira
  duplicada sob concorrência (a pré-checagem do use case tem janela de corrida)
- `wallet_ledger_amount_positive`, `wallet_ledger_balance_before_non_negative`,
  `wallet_ledger_balance_after_non_negative`, `wallet_ledger_direction_valid`
- `wallet_ledger_balance_consistent`:
  `CREDIT → after = before + amount`; `DEBIT → after = before - amount`
- `wager_transactions_kind_valid`, `wager_transactions_status_valid`,
  `wager_transactions_opening_internal` (OPENING sem metadados de provedor),
  `wager_transactions_amount_non_negative`, e as CHECKs que exigem referência
  para `REFUND`/`ROLLBACK` e metadados completos para kinds não-OPENING.

### Ledger append-only
Protegido **no banco**, não apenas no código:
```sql
CREATE TRIGGER wallet_ledger_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_entries ...
```
A migration tem caminho de reversão (`DROP TRIGGER IF EXISTS
wallet_ledger_immutable`), então é reversível nesse ponto.

> **Limitação:** não há CHECK de valor máximo monetário. O único teto é o
> próprio `numeric(20,2)`, que rejeita com erro do banco. O domínio
> antecipa essa falha, mas um caminho que contornasse o domínio dependeria
> do erro do PostgreSQL.

## Enums domínio ⇄ infraestrutura
As entidades em `src/infrastructure/persistence/entities/` **importam e
re-exportam** os enums do domínio em vez de redeclará-los. Isso evita
incompatibilidade de tipos entre as duas camadas. As entidades só usavam esses
enums como anotação de tipo, então a mudança não teve impacto runtime nem
exigiu migration nova.

## Casos de uso implementados

### `OpenWalletUseCase` (`src/application/wallets/use-cases/open-wallet.use-case.ts`)
Criação atômica de **wallet + transação `OPENING` + lançamento `CREDIT` +
evento `WalletBalanceChanged` na outbox**, tudo em uma única
`em.transactional` com um único `flush`.

- Saldo inicial **positivo** → os quatro registros.
- Saldo inicial **zero** → somente a wallet (sem transação, sem ledger, sem
  evento), conforme README 9.
- Duplicidade `playerId + currency` tratada em dois níveis: pré-checagem para
  falhar cedo **e** captura de `UniqueConstraintViolationException` vinda do
  banco — esta é a garantia real sob concorrência.
- Entrada inválida → `INVALID_PLAYER_ID` / `INVALID_INITIAL_BALANCE`.

### `ProcessBetUseCase` (`src/application/wagering/use-cases/process-bet.use-case.ts`)
Processa **BET** construindo-a no **domínio**, com lock pessimista da linha
da carteira (`findByIdForUpdate`), idempotência persistida e outbox atômica:

- **Construção via `WagerTransaction.createBet`** (README 6.3): campos
  obrigatórios, limites de coluna, formato do hash e valor positivo são
  validados **antes** de tocar o banco — payload inválido nunca alcança a
  wallet nem toma lock. A entidade é montada por `toTransactionEntity`
  (`src/application/wagering/process-support.ts`), no mesmo
  formato do registro de abertura do `OpenWalletUseCase`: todo estado da
  transação (kind, status, hash, rodada, jogo, código de falha,
  `processedAt`) vem do domínio; saldo e versão resultantes são estado de
  persistência do caso de uso (§7, regra 7 — o replay devolve o resultado
  observado naquele momento).
- **`roundId` e `gameId` são obrigatórios** — §6.3 os tipa não anuláveis em
  `WagerTransaction`, §9 os traz no corpo de `POST /wagering/transactions`
  e §10 na mensagem SQS. Três camadas de garantia: tipo obrigatório em
  `ProcessBetInput`, validação de presença na aplicação
  (`INVALID_ROUNDID` / `INVALID_GAMEID`, mesmo padrão dos demais campos) e
  a própria factory `createBet`. Entrada sem eles é **payload inválido**,
  não caminho de negócio.
- **Transições do domínio**: saldo suficiente → `markProcessed(undefined,
  now)` (`PENDING → PROCESSED`); saldo insuficiente →
  `reject(FailureCode.INSUFFICIENT_FUNDS)` (`PENDING → REJECTED`). Como
  `reject(code)` do esqueleto oficial não recebe data, `processed_at`
  permanece **nulo** em transações rejeitadas — antes era preenchido;
  alinhamento ao contrato oficial, coberto por teste unitário e de
  integração.
- O `payloadHash` vem de `hashWagerPayload` (ver abaixo); o hash fica em
  `wager_transactions.payload_hash`.
- Replay de `(providerId, idempotencyKey)` com hash igual → devolve o resultado
  original com `replayed: true`; hash diferente → `IDEMPOTENCY_PAYLOAD_CONFLICT`.
- **Corrida entre wallets distintas** (mesma chave, payloads diferentes, sem
  lock em comum): ambas chegam ao `INSERT` e o banco decide pela unique
  `wager_transactions_provider_idempotency_unique`. A
  `UniqueConstraintViolationException` é capturada fora da transação e
  resolvida em `resolveConcurrentDuplicate`, que relê a chave e devolve
  replay, conflito — ou propaga o erro original se a violação veio de outra
  constraint (ex.: `external_transaction_id`). Comportamento coberto por
  teste de concorrência em PostgreSQL real.
- Saldo insuficiente → transação `REJECTED` com `failureCode` do enum
  centralizado, `WagerTransactionRejected` na outbox e **sem**
  `WalletBalanceChanged`.
- Aprovação → `WalletLedgerEntry` DEBIT + `WagerTransactionProcessed` +
  `WalletBalanceChanged`.

> **Compartilhado:** validação de campos, mapeamento domínio → entidade,
> resultado de replay, gravação de outbox e resolução da corrida de
> idempotência saíram para `src/application/wagering/process-support.ts`
> (`validateRequiredStrings`, `toTransactionEntity`, `toProcessResult`,
> `persistOutboxEvent`, `resolveConcurrentDuplicate`), de modo que a WIN
> reutiliza **exatamente** o mesmo caminho — comportamento da BET idêntico
> ao anterior, coberto pela própria suíte.

> **Limite da época:** LOSS, REFUND e ROLLBACK não tinham caso de uso nesta
> fase — o domínio deles (factories e transições) já estava pronto e testado.
> Desde então entraram `ProcessLossUseCase` e `ProcessReversalUseCase`
> (ver "Regras de reversão (§7)" abaixo).

### `ProcessWinUseCase` (`src/application/wagering/use-cases/process-win.use-case.ts`)
Processa **WIN** implementando a política de referência registrada na seção
"Decisão — política de referência do `WIN`" acima, sobre a mesma máquina
compartilhada da BET:

- **Validação ANTES do banco e do lock:** campos obrigatórios
  (`INVALID_<CAMPO>`), `referenceExternalTransactionId` presente mas em
  branco → `INVALID_REFERENCEEXTERNALTRANSACTIONID` (ausente, `undefined`,
  **não** é erro: é a rota de "WIN sem referência"), `Money.from` e valor
  estritamente positivo. Nada disso toca a wallet.
- **Ordem de idempotência:** validação + `hashWagerPayload` (com `kind: WIN`
  e `referenceExternalTransactionId ?? null`) + `WagerTransaction.createWin`
  no domínio → `transactional` → **lock da wallet** → rechecagem da chave →
  resolução da referência. Replay devolve o resultado original com
  `replayed: true` e **não** resolve referência (§7, regra 7 + decisão,
  item 6).
- **Três desfechos**, todos em uma única transação SQL (§11):
  1. **sem referência, ou com referência resolvida** → `wallet.credit`,
     `markProcessed(targetId?, now)`, lançamento `CREDIT`,
     `WagerTransactionProcessed` + `WalletBalanceChanged`
     (`direction: CREDIT`);
  2. **alvo ainda inexistente** → `markPendingReference()`,
     `WagerTransactionPendingReference` na outbox, **sem** saldo, **sem**
     ledger e **sem** `WalletBalanceChanged` (§11: "somente quando o saldo
     muda"); o retorno `PENDING_REFERENCE` corresponde a "aceite com
     processamento pendente" (§9);
  3. **alvo existente em violação da regra 2** →
     `reject(FailureCode.REFERENCE_MISMATCH)` +
     `WagerTransactionRejected`, sem saldo nem ledger (regra 6).
- **Semântica da resolução** (`resolveReference`, sempre dentro do lock da
  wallet): consultas por coluna/filtro de PK, nunca pela relação não
  populada — `(providerId, externalTransactionId)`; sem linha, o mesmo
  `externalTransactionId` sob **outro** provider é `REFERENCE_MISMATCH`, e
  nenhuma linha é a "referência inexistente" da regra 8; com linha,
  conferem-se `playerId`, `currency`, `roundId` e `wallet` (filtro
  `{ wallet: id }`, como o MikroORM resolve o PK da relação). **Critério =
  existência + igualdade dos vínculos da regra 2; nenhuma checagem de
  status**, conforme o item 3 da decisão acima.
- **Corrida de idempotência entre wallets distintas** idêntica à da BET:
  `UniqueConstraintViolationException` capturada fora da transação →
  `resolveConcurrentDuplicate` (replay, conflito ou propagação do erro
  original).
- Eventos são gravados **apenas** no `flush` final, dentro da transação —
  nada é publicado antes do commit (§11).

#### Payload de `WagerTransactionPendingReference` — decidido ("Opção A")
Verificado em `docs/README-official.md`, **seção 11**: o README define o
envelope genérico (`IntegrationEvent`/`toJSON`) e o `data` **apenas** de
`WalletBalanceChanged`; o `data` de `WagerTransactionPendingReference` é
**decisão do projeto** (a única exigência textual é a linha da tabela
"Eventos mínimos": evento **referência ausente**). Aprovado em reunião:

```ts
// Envelope (§11) — mesma forma de todos os eventos
{
  eventId: randomUUID(),
  aggregateId: transactionId,                     // aggregateId da transação
  correlationId: correlationId ?? transactionId,
  occurredAt: now.toISOString(),                  // ISO-8601
  eventType: 'WagerTransactionPendingReference',
  version: 1,
  data: {
    transactionId: string,
    playerId: string,
    walletId: string,
    kind: 'WIN',
    status: 'PENDING_REFERENCE',
    amount: MoneyProps,                           // { amount, currency } decimal string
    referenceExternalTransactionId: string,
  },
}
```

Sem `balance` e sem `walletVersion`: **nada foi aplicado**, e o §11
restringe `WalletBalanceChanged` a "somente quando o saldo muda" — o
saldo observado é o da abertura, que já tem seu próprio evento. Coberto por
asserção exata do payload no unitário e no PostgreSQL real.

### Worker de referências pendentes (README §7.1)
Duas peças, separadas de propósito: o **caso de uso** conhece backoff, TTL,
claim e transações; o **worker** só agenda, loga e desliga.

#### Política — limite de tentativas **e** TTL (§7.1: "definido e justificado por você")

`src/application/wagering/reference-retry-policy.ts` — módulo puro, sem ORM
nem Nest, único dono dos números.

| Parâmetro | Valor | Justificativa |
|---|---|---|
| base | 5 s | entrega fora de ordem entre provedor e plataforma se resolve em segundos; a 1ª reavaliação imediata não tem o que encontrar |
| fator | 2 | backoff exponencial pedido pela §7.1 |
| teto de espera | 15 min | mantém a reavaliação dentro do mesmo dia útil |
| tentativas | 10 | 5+10+20+40+80+160+320+640+900+900 s = 3.075 s ≈ **51 min** de tentativas antes do esgotamento |
| TTL absoluto | 6 h | rede de segurança independente do contador: cobre downtime longo do worker (que congela as tentativas) sem reter transação indefinidamente |

§7.1 pede "limite de tentativas **ou** TTL"; aqui os dois são verificados
**independentemente** (`shouldRejectMissingReference` = tentativas **ou**
TTL): as tentativas limitam a rajada de reprocessamento, o TTL limita a
idade da pendência.

**Por que o TTL não aparece na consulta do claim.** A única condição de
elegibilidade é `reference_next_attempt_at <= now` — coluna indexada, sem
cálculo por linha. A janela é calculada como
`min(now + backoff, created_at + TTL)`, então vencido o TTL a janela cai no
**passado** e a linha fica elegível **a cada tick**. É assim que o TTL é
checado independentemente da janela de retry, sem que a consulta precise
conhecê-lo e sem deixar uma pendência expirada esperando o backoff.

#### Schema (`src/migrations/Migration20261024150000_PendingReferenceRetry.ts`)

| Objeto | Definição |
|---|---|
| coluna | `reference_attempts int NOT NULL DEFAULT 0` + CHECK `reference_attempts >= 0` |
| coluna | `reference_next_attempt_at timestamptz NOT NULL DEFAULT now()` |
| índice parcial | `wager_transactions_pending_reference_idx (reference_next_attempt_at, id) WHERE status = 'PENDING_REFERENCE'` |
| índice | `wager_transactions_external_id_idx (external_transaction_id)` — fallback da resolução por `(providerId, externalTransactionId)` |

Ambos os `down()` foram executados e reverificados no banco de integração
(saiem: contagem de colunas/índices/CHECK = 0; voltam: tudo restaurado).

Medição em **200.000 linhas** no banco de integração:

| Consulta | Com índice | Sem índice |
|---|---|---|
| claim (filtro + ordenação) | 0,296 ms / 42 buffers | 28,46 ms / 6.377 buffers |
| fallback por `external_transaction_id` | 0,059 ms / 4 buffers | 20,03 ms / 6.351 buffers (seq scan) |

O índice parcial é declarado também no entity (`@Index` com `where`), de
modo que `schema:refresh` não o abandona.

#### Claim — transação curta e própria

```sql
select id, wallet_id, reference_attempts, created_at
  from wager_transactions
 where status = 'PENDING_REFERENCE'
   and reference_next_attempt_at <= ?
 order by reference_next_attempt_at, id
 limit ?
 for update skip locked
```

- **`SKIP LOCKED`**: duas instâncias nunca disputam a mesma linha — quem
  chega depois pula a trava e leva outra.
- **`ORDER BY reference_next_attempt_at, id`**: ordem determinística, igual
  para todas as instâncias, coberta pelo índice parcial.
- **A tentativa é contada DURANTE o claim**, na mesma transação que
  seleciona: `reference_attempts + 1` e
  `reference_next_attempt_at = min(now + backoff, created_at + TTL)` são
  gravados **antes** de liberar a trava.

Consequência da posição do bump, documentada porque é decisão:

- **crash depois do claim e antes do commit financeiro** → a tentativa foi
  **consumida** e a janela futura já está gravada. A pendência **não se
  perde** (a linha segue `PENDING_REFERENCE`) e **não nasce um ciclo
  imediato** (só volta quando a janela abrir). Crash consome tentativa —
  é o preço de não reprocessar em rajada quando algo dá errado.
- **crash dentro do claim** → nada foi persistido; o próximo ciclo tenta de
  novo com a mesma janela.
- falha em **uma linha** não aborta o lote: o erro vira um
  `PendingReferenceProblem` estruturado e a linha se recupera sozinha na
  janela seguinte. Falha do **claim** propaga: nenhum estado alterado e o
  worker tenta no ciclo seguinte.

#### Aplicação — uma transação financeira por linha

Ordem deliberada em `applyRow`:

1. **lock da wallet** (`PESSIMISTIC_WRITE`);
2. **releitura da linha** — se outra instância já a tornou terminal, `skipped`;
3. `rehydrate` no domínio e guardas de estado persistido — player/moeda
   divergentes da wallet e campos ausentes viram `inconsistent`;
4. `resolveReference` por `(providerId, referenceExternalTransactionId)`,
   **sem** aceitar a própria linha como alvo;
5. crédito (`resolved`) ou `REFERENCE_MISMATCH` (`rejected`);
6. **só aqui** o limite/TTL (`shouldRejectMissingReference`).

O passo 6 fica **depois** da resolução de propósito: a referência pode
chegar mesmo com o TTL vencido, e rejeitar nesse caso descartaria uma
transação recuperável.

| Desfecho | Quando | Efeito |
|---|---|---|
| `resolved` | referência encontrada | saldo + ledger `CREDIT` + transação `PROCESSED` (com `reference_transaction_id`) + outbox `WagerTransactionProcessed` e `WalletBalanceChanged`, tudo no mesmo commit; saldo observado (`result_balance_*`) e versão são **atualizados** |
| `rejected` | `REFERENCE_MISMATCH` ou esgotado o limite/TTL | `REJECTED` + `REFERENCE_NOT_FOUND`/`REFERENCE_MISMATCH` + outbox `WagerTransactionRejected` **atomicamente**, sem saldo |
| `inconsistent` | linha `PENDING_REFERENCE` irrecoverável (sem referência/provider/rodada, ou player/moeda divergentes da wallet) | `FAILED` + `INTERNAL_ERROR` + problema `UNRESOLVABLE_STATE`; **sem evento** — ver abaixo |
| `stillPending` | referência ainda ausente dentro do orçamento | nada muda nesta transação (tentativa e janela já vêm do claim); o evento `WagerTransactionPendingReference` **não é reemitido** por tentativa |
| `skipped` | linha já terminal ao chegar no lock | corrida com outra instância, sem efeito |

**Anomalia ≠ referência inexistente.** Uma linha `PENDING_REFERENCE` com
`reference_external_transaction_id` nulo (ou sem `provider_id`/`round_id`,
sem os quais a regra 2 nem se confere) é inconsistência de estado, **nunca**
`REFERENCE_NOT_FOUND` — nada no sistema volta a gravar esses campos depois
da inserção, então a linha é irrecoverável por construção. Vira `FAILED` +
`FailureCode.INTERNAL_ERROR` (§6.3) com estado terminal auditável, e o
problema estruturado vai para o worker registrar. **Sem evento**: a §11 não
define evento para falha de infraestrutura, e `WagerTransactionRejected`
significa regra de negócio.

Vale o mesmo para o vínculo com a wallet: `wallets.player_id` e a moeda da
wallet não mudam depois da abertura e são conferidos na entrada da WIN, então
uma linha que os contradiz é erro permanente de infraestrutura (§6.3), não
algo que se resolva esperando — antes da correção, esses casos eram capturados
pelo `catch` por linha como `PROCESSING_FAILED` e reivindicados a cada janela
para sempre. Agora terminam pelo mesmo caminho da anomalia acima, com o
problema `UNRESOLVABLE_STATE` carregando `missing: 'player_id'` ou
`'currency'`. `WALLET_NOT_FOUND` e `REFERENCE_RESOLUTION_WITHOUT_TARGET`
continuam lançando erro: são guardas de programação inalcançáveis (FK
`on delete restrict` em `wallet_id`; a política de resolução só devolve alvo
com linha) e não há resultado observado para auditar.

**Referência nunca é a própria transação.** A `WIN` referencia a `BET` da
mesma rodada (§7, tabela), então `resolveReference` descarta a própria linha
(`excludeId`): uma `WIN` com `referenceExternalTransactionId` igual ao
próprio `externalTransactionId` não tem alvo — e como `(provider_id,
external_transaction_id)` é único, nunca terá. É **referência ausente** (§7,
regra 8): segue `PENDING_REFERENCE` e termina pela §7.1 com
`REFERENCE_NOT_FOUND`, em vez de creditar a si mesma.

**Idempotência multi-instância, três camadas** (nenhuma depende de SQS):
`SKIP LOCKED` evita a disputa; o lock da wallet serializa as decisões; a
releitura feita **depois** do lock enxerga o commit do par (READ COMMITTED)
e a unique `(wallet_id, transaction_id)` do ledger derruba a transação
inteira se mesmo assim houver duas. Saldo, ledger, transação e outbox
seguem na mesma transação; nada é publicado antes do commit (a outbox é
gravada aqui e só sai para o SQS depois do commit, pelo
`OutboxPublisherWorker`).

#### Worker (`src/infrastructure/workers/pending-reference.worker.ts`)

Provider NestJS com `onModuleInit`/`onModuleDestroy` e um único
`setInterval` — deliberadamente **sem** `@nestjs/schedule`: uma dependência
não se justifica para um agendador. Quatro responsabilidades, todas
infraestruturais:

1. agendar o ciclo e impedir **sobreposição** (um ciclo lento não acumula:
   o seguinte é pulado e nada se perde, porque a janela já está gravada);
2. **não morrer** com a exceção: falha do claim é logada e o próximo ciclo
   tenta de novo;
3. log **estruturado** de `result.problems` — apenas identificadores e
   motivo, nunca payload financeiro (proibido pelo `AGENTS.md`); resumo do
   ciclo só quando houve claim;
4. desligamento limpo (o timer é removido, não sobrevive ao processo).

Configuração (`.env.example`): `PENDING_REFERENCE_POLL_MS` (padrão 5000 ms,
mínimo 100 ms — valor inválido cai no padrão em vez de parar o worker ou
virar busy-loop) e `PENDING_REFERENCE_WORKER_ENABLED=false` para não
agendar.

`correlationId` dos eventos gerados pelo worker = `transactionId`: o
`correlation_id` original da requisição não é uma coluna persistida.

#### Cobertura desta frente
- 11 unitários do caso de uso + 12 do worker (política, agendamento,
  sobreposição, logs) — 177 testes unitários no total **na época da Fase 13**;
  para os totais atuais, consulte `PROGRESS.md`, na seção de validações.
- 8 cenários de integração em PostgreSQL real: referência tardia + replay
  terminal, backoff/janela, esgotamento das 10 tentativas, TTL sem esperar a
  janela, **duas instâncias na mesma linha**, **lote 4×2 workers**, crash
  antes do commit com recuperação e crash depois do commit.

### Publicação da outbox (README §11) — `src/application/messaging/`

`PublishOutboxMessagesUseCase` + `OutboxPublisherWorker`
(`src/infrastructure/workers/outbox-publisher.worker.ts`), com a porta
`OutboxPublisher` (`src/application/messaging/outbox-publisher.ts`) e a
implementação em SQS (`src/infrastructure/sqs/sqs-outbox-publisher.ts`).

O evento já nasce **atômico** com os efeitos financeiros: `persistOutboxEvent`
roda na mesma transação do saldo/ledger, comprovado por rollback real. O que
este incremento cobre é a **publicação** do que ficou confirmado:

1. **claim numa transação curta** — `SELECT … WHERE status = 'PENDING' AND
   next_attempt_at <= now … LIMIT n FOR UPDATE SKIP LOCKED`
   (índice `outbox_status_next_attempt_idx`), com a tentativa contada e a
   próxima janela gravadas **antes** de soltar a linha;
2. **publicação fora da transação** — o SQS é externo e não participa do
   commit;
3. `PUBLISHED` + `published_at` por mensagem, ou `last_error` quando falha.

| Decisão | Escolha | Por quê |
|---|---|---|
| fila de destino | `SQS_EVENTS_QUEUE_URL` → `wager-events.fifo` (FIFO), **dedicada** aos eventos da outbox | a §11 não nomeia destino: separar eventos de integração da fila de **comandos** (`wager-transactions.fifo`, §10) é decisão arquitetural aprovada, para que o consumer da §10 só receba `WagerTransactionRequested` |
| corpo da mensagem | `outbox_messages.payload`, sem reescrita | §11: o envelope gravado é o contrato dos eventos |
| `MessageGroupId` | `aggregateId` | FIFO exige agrupador; eventos do mesmo agregado preservam a ordem |
| `MessageDeduplicationId` | id da mensagem (é o `eventId`) | **proteção adicional**: absorve reenvios muito próximos dentro da janela do broker — não é a garantia final (§8) |
| quando a tentativa é contada | no claim, como na §7.1 | a queda entre claim e publicação consome um slot e mantém a mensagem elegível |
| limite e backoff | sem teto de tentativas; backoff `5 s × 2^(n−1)` com teto de 15 min (`reference-retry-policy.ts`) | o evento já foi **confirmado no commit**, então §3 ("não perder eventos confirmados") e §11 ("sem perder nem duplicar indefinidamente") exigem entrega eventual; o teto limita a cadência, não a entrega |
| mensagem esgotada | segue `PENDING` e volta a ser reivindicada na janela de backoff | o orçamento de tentativas (10) foi removido após auditoria: com ele, uma mensagem que esgotasse as tentativas ficaria `PENDING` para sempre sem publicação — perda de evento confirmado |
| `status = PROCESSING`, `locked_at`, `lock_owner` | **não usados** | o esqueleto oficial (§6.5) só prevê `isPending`/`isDue`/`markPublished`/`scheduleRetry`, e a janela gravada no claim já impede claim duplo sem deixar lock órfão |

**Nada se perde:** uma queda entre o claim e a publicação deixa a mensagem
`PENDING` com a janela gravada — o próximo ciclo a encontra sozinha. O que o
`SKIP LOCKED` garante é que **dois publishers não levam a mesma mensagem ao
mesmo tempo**; um reenvio do mesmo evento (queda entre publicar e marcar)
**pode** chegar ao consumidor. A deduplicação FIFO do SQS protege reenvios
muito próximos, mas é **otimização** — o README (§8) é explícito em que
recursos do broker não são a garantia final. Tornar uma duplicata segura é
tarefa do **consumidor**, via Inbox persistente por `(consumerName,
messageId)` (§10) — implementado no consumidor de comandos (ver abaixo).

**Shutdown** (§10/§14): `main.ts` habilita `app.enableShutdownHooks()`, então
em SIGTERM/SIGINT o NestJS chama `onModuleDestroy` do worker — que para o
timer e **aguarda o ciclo em andamento**. Se o processo morrer mesmo assim, a
janela do claim devolve a mensagem ao próximo ciclo.

### Consumidor de comandos (README §10) — Inbox transacional

`ReceiveWagerTransactionUseCase` + `WagerCommandConsumerWorker`
(`src/infrastructure/workers/wager-command-consumer.worker.ts`), fila
`SqsCommandQueue` (`src/infrastructure/sqs/sqs-command-queue.ts`) e envelope
`WagerTransactionRequested` (`src/application/messaging/`).

**Atomicidade (§11).** O caso de uso abre UMA transação, registra a Inbox e
chama `ProcessBetUseCase`/`ProcessWinUseCase` com o **mesmo**
`EntityManager`: o `transactional` interno deles vira **savepoint na mesma
conexão** (MikroORM v7 — `TransactionManager.executeNestedTransaction` →
`AbstractSqlConnection.begin` com `ctx`, e `commit`/`rollback` por
`releaseSavepoint`/`rollbackToSavepoint`). Inbox, saldo, `wager_transactions`,
ledger e outbox confirmam **juntos**; em qualquer falha nada é confirmado —
nem a própria Inbox. Os casos de uso financeiros **não** precisaram de
alteração.

| Decisão | Escolha | Por quê |
|---|---|---|
| identidade da mensagem | `messageId` do envelope + `consumerName` lógico (`wager-transactions`) | §10/§6.5 deduplicam por `(consumerName, messageId)`; o nome tem de ser igual em todas as instâncias |
| `referenceExternalTransactionId` | aceito como opcional em `data` | o exemplo da §10 omite o campo, mas §7 (regras 1 e 2) exige quando o kind referencia |
| `kind` | despacho para os **mesmos casos de uso da entrada HTTP** — `BET` → `ProcessBetUseCase`, `LOSS` → `ProcessLossUseCase`, `REFUND`/`ROLLBACK` → `ProcessReversalUseCase`, `WIN` → `ProcessWinUseCase` | §10: "reutilizar o mesmo use case da entrada HTTP" |
| negócio | o caso de uso **retorna** (inclusive `REJECTED`) → ack | §10: "erros de negócio (terminal, ack)" |
| permanente | envelope inválido e `IDEMPOTENCY_PAYLOAD_CONFLICT` → DLQ e, **só então**, ack | §10: "permanentes (DLQ)"; §9: conflito, não replay |
| transitório | todo o resto → **sem ack** | §10: "transitórios (retry com backoff)"; a visibilidade do SQS reentrega e o `maxReceiveCount` leva à DLQ |
| corrida na Inbox | violação da única → ack (a outra instância confirmou) | o índice único só acusa depois do commit concorrente |
| `payloadHash` da Inbox | mesmo hash canônico dos casos de uso (`hashWagerPayload`) | §9: JSON canônico do subconjunto de negócio |

Não se alega entrega exactly-once: a garantia é da Inbox persistente, da
unique de idempotência e da atomicidade da transação.

### Regras de reversão (§7) — `ProcessReversalUseCase`

`REFUND` e `ROLLBACK` compartilham um caso de uso, com o julgamento
centralizado em `evaluateReversal`
(`src/application/wagering/process-support.ts`) — **o mesmo** aplicado pelo
worker de §7.1 quando a reversão nasce pendente e é resolvida depois:

- **regra 1**: a referência externa é obrigatória (a factory recusa sem ela);
- **regra 3**: a referência precisa estar `PROCESSED` e ser do tipo que a
  operação pode reverter — `REFUND` só reverte `BET`; `ROLLBACK` reverte
  `BET`, `WIN` ou `REFUND`. Referência rejeitada, pendente ou falha nunca
  moveu dinheiro e não é alvo elegível (`REFERENCE_MISMATCH`);
- **regra 5**: o valor é **igual** ao da referência
  (`REFERENCE_AMOUNT_MISMATCH`);
- **regra 4 ampliada**: cada referência recebe no máximo **uma** reversão
  processada, **independentemente do tipo** — `REFUND` e `ROLLBACK` da mesma
  referência não se somam. Continua permitido reverter um `REFUND` com
  `ROLLBACK`: aí a referência é o próprio `REFUND` (outra chave).

| Garantia | Mecanismo |
|---|---|
| nunca duas reversões processadas do mesmo alvo | índice parcial `wager_transactions_reversal_unique` **e** `Migration20261025160000_ReversalUniquePerReference` (`(provider_id, reference_external_transaction_id)` sobre `kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`) |
| o perdedor da corrida não se perde em silêncio | a transação financeira inteira é desfeita e a tentativa vira linha `REJECTED` com `REFERENCE_ALREADY_REVERSED`, em transação própria, mais evento de rejeição (auditoria); resposta HTTP **409**, na primeira chamada e no replay |
| auditoria que falha não vira sucesso | se a linha de auditoria não puder ser gravada (banco indisponível, ou outra tentativa idêntica já a gravou), o conflito continua reportado como erro e a falha vai para o log estruturado — nunca se afirma que a auditoria persistiu quando não persistiu |

Trade-off registrado: o alvo precisa estar `PROCESSED` porque referência
rejeitada/pendente nunca moveu dinheiro — permitir reverter essas linhas
criaria lançamento sem efeito correspondente. Testes em
`reversal.integration.e2e-spec.ts` e, entre processos, em
`multi-process.integration.e2e-spec.ts` (corrida `REFUND` × `ROLLBACK`).

### Hash de idempotência (`src/application/wagering/payload-hash.ts`)
Algoritmo exigido pelo README §9 ("payloadHash = hash de um JSON canônico
(chaves ordenadas) do subconjunto de campos de negócio ... O algoritmo deve
estar documentado"):

- **SHA-256**, em hexadecimal minúsculo (64 caracteres), sobre o
  `JSON.stringify` dos campos de negócio **ordenados alfabeticamente**, sem
  espaços.
- Campos: `amount`, `currency`, `externalTransactionId`, `gameId`,
  `kind`, `playerId`, `providerId`, `referenceExternalTransactionId`,
  `roundId`, `walletId`.
- `kind` participa do hash: a unique de idempotência é **global** por
  `(providerId, idempotencyKey)`, então a mesma chave usada para operações
  de tipos diferentes precisa ser conflito, não replay (§9: "mesma key com
  payload diferente → conflito"). Antes desta etapa o `kind` não entrava —
  divergência corrigida e coberta por teste.
- Campo sem dado é sempre enviado como `null` (tipos do contrato), e um
  valor `undefined` em runtime também é normalizado para `null`.
- O header `Idempotency-Key` e metadados de transporte não participam: o
  tipo `WagerPayload` nem os aceita (garantia de tipo, testada).
- `roundId`/`gameId` já participavam.

### Observabilidade (README §12) — `src/infrastructure/observability/`

Etapa final de entrega (o §12 marca o item como obrigatório; OpenTelemetry e
dashboard são opcionais):

- **logs estruturados (JSON)** — `structured-logger.ts`: `logEvent` emite uma
  linha JSON por evento de ciclo de vida (comandos consumidos, retry, DLQ)
  com `correlationId`, `messageId`, `transactionId`, `walletId` e
  `providerId`; `JsonLogger` (adapter `LoggerService`, registrado em
  `main.ts`) faz framework e workers saírem no mesmo formato. Nenhum log
  carrega payload financeiro completo — só identificadores e motivos.
- **métricas** — `metrics.ts`: registro em memória (contadores, gauges e
  durações), sem dependências novas, exposto em `GET /metrics` como JSON.
  Cobre o mínimo do §12: `wager_transactions_total{status,kind}`,
  `duplicates_detected_total{source}`, `retries_total{component}`,
  `dlq_messages_total`, `lock_conflicts_total{scope}`, `outbox_lag_ms` e
  `processing_latency_ms{component}`. Instrumentação nos pontos reais:
  `toProcessResult`/`resolveConcurrentDuplicate` (process-support),
  publicação da outbox, resolução de referências pendentes e consumidor.
- **limitação honesta:** o registro é **por processo**; com múltiplas
  instâncias, cada `/metrics` reporta a própria instância. Agregar seria
  exporter/OTel (opcional no §12), fora do escopo desta entrega.
- **health checks** — já existentes e separados (`/health/live`,
  `/health/ready`).

## Modelagem de eventos — adaptação deliberada (§6.5 e §11)
O README oficial define `IntegrationEvent<T>` (classe abstrata com uma
subclasse por evento) e `OutboxMessage` (classe de domínio com
`enqueue`/`markPublished`/`scheduleRetry`). O **§6 (cabeçalho)** autoriza
adaptar: "Nomes e assinaturas podem ser adaptados, desde que as garantias
sejam preservadas", e o **§6.0** classifica os blocos como "esqueletos de
referência: o que importa é que o estado seja encapsulado e as transições
sejam explícitas".

**Decisão:** não replicar as classes literalmente; preservar as garantias.
O que está verificado:

- o payload gravado na outbox é exatamente o `toJSON()` do esqueleto —
  `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`
  (ISO-8601), `version` e `data` (`persistOutboxEvent`, em
  `process-support.ts`);
- `data` carrega `MoneyProps` (string decimal), **nunca** a instância de
  `Money`; `causationId` é opcional no contrato e não é usado;
- o estado e as transições do `OutboxMessage` (§6.5) existem em
  `OutboxMessageEntity` + `OutboxMessageRepository`: `isPending` (`status`),
  `isDue` (`next_attempt_at <= now`), `markPublished` e a tentativa com
  backoff gravadas no claim.

**Proposta (não implementada — refatoração ampla, fora de escopo):**
hierarquia `IntegrationEvent<T>` abstrata com uma subclasse concreta por
evento (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged`, `WagerTransactionPendingReference`) e
`OutboxMessage.enqueue(event)` como única porta de gravação. Ganho: o
`eventType`/`version` passam a viver no tipo, e não em uma string no call
site. Custo: tocar todos os casos de uso e os testes que fixam o payload —
a fazer em etapa própria, com a suíte completa como rede de segurança.

## Contrato do evento `WalletBalanceChanged` (README §11)
Aplicado por `OpenWalletUseCase`, `ProcessBetUseCase` e `ProcessWinUseCase`:

```ts
interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection; // CREDIT na abertura, DEBIT na BET
  money: MoneyProps;          // movimento do lançamento
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
```

Decisões:
- O payload segue **exatamente** a interface do README. `playerId` foi
  removido: não existe no contrato documentado e é recuperável pela
  carteira/transação.
- Todo valor monetário é `MoneyProps` com duas casas decimais. Nunca `number`.
- `direction` reflete o lançamento real do ledger, do mesmo caminho de código
  que o produziu.
- Só é gravado quando o saldo muda de fato: abertura com saldo zero e BET
  rejeitada não emitem `WalletBalanceChanged` (a BET rejeitada ainda emite
  `WagerTransactionRejected`).
- A outbox é gravada na mesma transação SQL da operação financeira.

> **Divergência conhecida:** o `WagerTransactionProcessed` emitido pelo
> `ProcessBetUseCase` usa um shape próprio, pois o README §11 lista o evento
> como exigido mas não documenta os campos dele. Convém decidir o contrato
> junto com os fluxos WIN/LOSS/REFUND/ROLLBACK.

## Infraestrutura de testes de integração
A suíte (`bun run test:integration`) usa serviços reais — nunca mocks, nunca
uma segunda implementação de persistência. Os fakes
(`test/support/fake-entity-manager.ts`) ficam restritos aos unitários, onde
modelam apenas a orquestração.

### Isolamento
- `compose.integration.yaml` sobe containers, volumes e portas próprios
  (`127.0.0.1:5433` e `127.0.0.1:4567`), em loopback.
- Banco exclusivo `wagering_integration`; `DATABASE_URL` de desenvolvimento
  nunca é lida.
- Migrations rodam somente no banco de integração, usando os arquivos já
  versionados. Hoje são quatro (`InitialSchema`, `PendingReferenceRetry`,
  `ReversalUniqueProcessed` e `ReversalUniquePerReference`); as três
  últimas tiveram `up` **e** `down` executados à mão no banco de
  integração, com conferência de índices/colunas nas duas direções.
- O LocalStack de integração não usa o `init-queues.sh` de dev: a própria
  suíte cria e confere a sua fila.
- `assertDedicatedIntegrationDatabase()` recusa qualquer banco sem sufixo
  `_integration`, **antes** de conectar ou truncar.
- `fileParallelism: false` em `vitest.config.integration.ts`: os arquivos
  compartilham o banco, então rodam em série para serem repetíveis.

### O que está coberto hoje
- Rollback real no PostgreSQL, limitado à transação (o dado pré-existente
  sobrevive).
- `OpenWalletUseCase` gravando wallet, OPENING, ledger e outbox
  atomicamente, com reconciliação lida por SQL cru.
- Constraints reais: `wallets_balance_non_negative` e
  `wallets_player_currency_unique`, e o trigger `wallet_ledger_immutable`
  (`UPDATE`/`DELETE` rejeitados).
- **Concorrência real** (`concurrency.integration.e2e-spec.ts`): 2, 5 e 50
  apostas simultâneas na mesma wallet, replay e conflito de idempotência,
  abertura concorrente de wallet e wallets distintas em paralelo — cada
  requisição com `EntityManager` e conexão próprias, estado persistido
  conferido por SQL cru após cada cenário, com o invariante final
  `wallet.balance == saldo reconstruído pelo ledger`.
- **`ProcessWinUseCase`** (`win.integration.e2e-spec.ts`): crédito imediato,
  `PENDING_REFERENCE` com o payload aprovado, replay pendente que **não**
  resolve, referência resolvida com FK interna, divergência de rodada
  (`REFERENCE_MISMATCH`), duas requisições idênticas concorrentes com um
  único crédito, conflito de idempotência, **rollback real provocado por um
  proxy que falha após o `flush` da outbox** (saldo, ledger, transação e
  outbox desfeitos — e o reenvio da mesma WIN aplicando normalmente) e o
  invariante final conferido em todos os cenários.
- **Worker de §7.1** (`pending-reference.integration.e2e-spec.ts`): 8
  cenários — referência que chega depois, backoff com janela em
  `reference_next_attempt_at`, esgotamento das 10 tentativas, TTL sem
  esperar a janela, **duas instâncias concorrentes na mesma linha com um
  único crédito**, **lote de 4 linhas drenado por 2 workers**, crash antes
  do commit (tudo desfeito, pendência preservada, sem ciclo imediato) e
  crash depois do commit (próximo ciclo não reaplica). O invariante
  `wallet.balance == saldo reconstruído pelo ledger` roda em todos.
- Existência/criação da fila SQS no LocalStack e separação em relação às
  filas de dev.
- Falhas de conexão derrubam a suíte: `ECONNREFUSED` no PostgreSQL e
  `fetch failed` no SQS não são engolidos.

### Limitação conhecida do harness
`em.getConnection().execute()` roda em autocommit **fora** da transação
corrente. Para exercitar rollback é preciso usar o Unit of Work
(`tx.persist()` + `tx.flush()` dentro de `em.transactional`), que é também o
caminho do código de produção.

### Cliente SQS
O projeto **não tem o AWS SDK** (nenhuma dependência `@aws-sdk/*` no
`bun.lock`), e o README (§4) pede AWS SQS via LocalStack/MiniStack, não um SDK
específico. O transporte é um cliente HTTP mínimo com SigV4 sobre `fetch` +
`node:crypto`, em `src/infrastructure/sqs/sqs-client.ts` — o mesmo código usado
pelo publisher da outbox e pela suíte de integração
(`test/integration/support/sqs.ts` só acrescenta as operações de
administração de fila, exclusivas do harness). Assim os testes exercitam o
transporte real em vez de um paralelo (§13).

---

# 2. Planejado (não implementado)

Restam deste escopo:

- `messaging`: o consumidor dos **eventos** da outbox (§11, passo 5) — quem
  torna a duplicata de publicação segura do lado dos eventos;
- `observabilidade` (§12): logs JSON estruturados com IDs de correlação e
  métricas operacionais;
- `bun run test:e2e` do scaffold (falha por configuração conhecida,
  registrada em `PROGRESS.md`);
- decisão sobre `WalletRepository.create` (remover ou tornar transacional).

Tudo o mais está implementado: os cinco casos de uso de wagering
(`ProcessBet`, `ProcessWin`, `ProcessLoss`, `ProcessReversal`,
`ResolvePendingReferences`), a camada HTTP completa (seção seguinte), a
`idempotência` (`payload-hash.ts`, com replay/conflito centralizados em
`process-support.ts`), o `messaging` (Inbox, consumidor de comandos,
publisher da outbox) e o `health` (`/health/live`, `/health/ready`).

### Contratos HTTP do README oficial — implementados (§9)
`POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`
(cursor opaco), `POST /wallets/:walletId/reconciliation`,
`POST /wagering/transactions` (com `Idempotency-Key`),
`GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`,
`GET /health/live` e `GET /health/ready` — em `src/http/`, com **um único
mapeamento de status** para todos os endpoints (400 payload inválido, 404 não
encontrado, 409 conflito de idempotência/reversão, 422 rejeição de regra,
202 aceite pendente, 503 falha transitória). Os controllers não têm regra
financeira: reutilizam os casos de uso. Testes em
`test/integration/http.integration.e2e-spec.ts`.

### Concorrência
O lock pessimista (`PESSIMISTIC_WRITE`) em
`WalletRepository.findByIdForUpdate` e a unique `wallets_player_currency_unique`
estão **comprovados sob concorrência real** contra PostgreSQL: apostas
simultâneas na mesma wallet (2, 5 e 50), abertura concorrente de wallet e
wallets distintas em paralelo
(`test/integration/concurrency.integration.e2e-spec.ts`), com o estado
persistido verificado por SQL após cada cenário. Duas **instâncias do
worker de §7.1** drenando o mesmo lote também estão cobertas
(`pending-reference.integration.e2e-spec.ts`): `EntityManager` e conexões
distintas, `SKIP LOCKED` + lock da wallet + releitura pós-lock, com um único
crédito por linha. **Entre processos independentes** há teste próprio
(`multi-process.integration.e2e-spec.ts`): dois processos `bun`, conexões
próprias e largada simultânea — cenário do §8, corrida `REFUND` × `ROLLBACK`
e redelivery após commit sem duplicar efeitos. **O que ainda não existe:**
execução com **três ou mais processos/instâncias** simultâneos e **reinício
do serviço**.

### Mensageria
A entrega é at-least-once com deduplicação; não se promete exactly-once entre
PostgreSQL e SQS — a garantia é da persistência (§5.2). Implementados: o
**worker de referências atrasadas (§7.1)**, o **publisher da outbox (§11)** e o
**consumidor da fila de comandos (§10)**, com Inbox persistente por
`(consumerName, messageId)`, Inbox + efeitos + ledger + outbox na **mesma
transação**, `ack` somente depois do commit, DLQ para erros permanentes e
reentrega por visibilidade para os transitórios (`maxReceiveCount` decide o
limite). **Continua faltando** o consumidor dos **eventos** da outbox (quem
torna a duplicata de publicação segura, §11:5); a observabilidade (§12) está
implementada no mínimo do contrato (seção própria acima).

### Riscos pendentes
- **`WalletRepository.create`** (`src/infrastructure/persistence/repositories/wallet.repository.ts`)
  cria a wallet **sem** os registros financeiros obrigatórios (sem transação,
  sem ledger, sem outbox) e fora de transação. Não é usado pelos casos de uso
  atuais, mas é um caminho inseguro que precisa ser removido ou corrigido.

### Autenticação
**Decisão (README §2): não implementar** autenticação nesta entrega — o §2
não pontua e ela não podia competir com correção financeira, concorrência,
idempotência e mensageria. Nada de autenticação artesanal (sem tabela de
usuários, sem hash de senha).

**Desenho que seria adotado:** integrar um **IdP externo/OIDC** (Keycloak ou
Zitadel, ambos sobem em Docker Compose); os endpoints de negócio passariam a
validar o JWT de acesso no `AuthGuard`; `/health/live` e `/health/ready`
continuam **abertos** (§2); a identidade do provedor dentro das mensagens da
fila segue sujeita às mesmas validações de domínio — uma
`ProviderIdentityPort` extrairia essa identidade do envelope, hoje lida
diretamente de `data.providerId`.

**Ponto de extensão explícito no código:** `src/http/auth.guard.ts`
(`AuthGuard` no-op, registrado como `APP_GUARD` em `app.module.ts`) — a troca
por um guard real acontece ali, sem tocar nos controllers. Contrato HTTP
inalterado.

### Observabilidade
Implementada no mínimo do §12: logs estruturados em JSON
(`src/infrastructure/observability/structured-logger.ts`) com
`correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` nos
pontos de processamento HTTP, no consumidor e na publicação da outbox — sem
payload financeiro completo; métricas em `GET /metrics`
(`src/infrastructure/observability/metrics.ts`), incluindo as divergências de
reconciliação exigidas pela §9. **Limitação:** o registro de métricas é por
processo — sem agregação entre instâncias (exporter/OTel é opcional).

### Testes ainda não cobertos
**Reinício do serviço em si** (subir o Nest completo com workers, derrubar com
SIGTERM e subir de novo) — a recuperação **por nova instância** já é coberta
em `multi-process.integration.e2e-spec.ts`: a instância que comitou termina
sem publicar e um processo novo, com conexões próprias, drena a outbox para o
SQS real e o estado final reconcilia (`wallet.balance == ledger`). **≥3
processos simultâneos** também está coberto desde a última rodada (4
processos disputando o mesmo saldo, com a invariante da §13). Continuam
fora: o reinício com SIGTERM do serviço completo e a reversão (`down`) da
migration inicial em banco real (a `down` de `PendingReferenceRetry` e das
duas migrations de reversão já foi executada e conferida). Publicação
(queda antes/depois do commit, dois publishers, retentativa) coberta em
`outbox-publisher.integration.e2e-spec.ts`; consumo (reentrega sem duplicar,
atomicidade, queda entre commit e ack, transitório até a DLQ, permanente à
DLQ, concorrência entre instâncias) em
`wager-command-consumer.integration.e2e-spec.ts`; concorrência, corrida de
reversão, redelivery, ≥3 processos e recuperação por nova instância **entre
processos independentes** em `multi-process.integration.e2e-spec.ts`.
