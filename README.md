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
- `PLAN.md` — fases, prioridades e próxima sequência de trabalho.
- `ARCHITECTURE.md` — decisões técnicas, o que está implementado e o que é apenas planejado.
- `ACCEPTANCE_CHECKLIST.md` — estado por requisito e por risco eliminatório.
- `PROGRESS.md` — cronologia do que foi feito, decisões, problemas e validações.

## Estado atual da implementação
O desafio especifica uma API completa de apostas. **Isto ainda não está
pronto.** O que existe hoje é o núcleo financeiro transacional:

| Área | Estado |
|---|---|
| `Money` (decimal exato, faixa `numeric(20,2)`) | implementado e testado |
| `Wallet`, `WalletLedgerEntry` | implementados e testados |
| `WagerTransaction` | **domínio completo**: factories das 6 operações, transições e consultas |
| Abertura de carteira (`OpenWalletUseCase`) | implementado; atomicidade verificada em PostgreSQL real |
| Aposta (`ProcessBetUseCase`) | implementado e integrado ao domínio (`WagerTransaction.createBet`); `roundId`/`gameId` obrigatórios na entrada; validado contra PostgreSQL real, incluindo cenários de concorrência |
| Prêmio (`ProcessWinUseCase`) | implementado com a política de referência decidida: crédito imediato sem referência; `PENDING_REFERENCE` + evento `WagerTransactionPendingReference` quando o alvo não existe; `REFERENCE_MISMATCH` em divergência de vínculo; replay não resolve referência; validado em PostgreSQL real, inclusive com rollback provocado |
| Worker de referências pendentes (§7.1) | implementado: backoff exponencial (5 s × 2^(n−1), teto 15 min), 10 tentativas e TTL de 6 h, claim `FOR UPDATE SKIP LOCKED`, rejeição atômica `REFERENCE_NOT_FOUND`; validado em PostgreSQL real com 2 instâncias concorrentes e crashes |
| LOSS, REFUND, ROLLBACK | **domínio implementado e testado; sem casos de uso nem HTTP** |
| Endpoints HTTP | **nenhum** |
| Publisher da outbox (§11) | implementado: o worker lê `outbox_messages`, publica em SQS e marca `PUBLISHED`; claim `FOR UPDATE SKIP LOCKED` com tentativa e janela gravadas antes de publicar, retentativas limitadas com backoff e desligamento gracioso; validado em PostgreSQL e LocalStack reais |
| Inbox, consumer SQS, DLQ | **não implementados** (o retry/backoff da publicação da outbox está implementado e testado) |
| Logs, métricas, liveness/readiness | **não implementados** |

Ter tabela, enum ou constraint prontos **não** significa que o fluxo de
negócio está concluído. O detalhamento está em `PLAN.md` e
`ACCEPTANCE_CHECKLIST.md`.

**Importante:** nenhum trabalho desde a fundação está commitado. Todo o
conteúdo de `src/domain/`, `src/application/`, `src/infrastructure/`,
`src/migrations/`, `test/` e dos arquivos de infraestrutura são alterações
locais não versionadas.

## Idempotência — algoritmo do `payloadHash` (README §9)
O README oficial exige que o algoritmo do `payloadHash` esteja documentado.
Implementação: `src/application/wagering/payload-hash.ts`.

```
payloadHash = sha256_hex( JSON_canônico(payload_de_negócio) )
```

- **JSON canônico**: chaves ordenadas alfabeticamente, sem espaços.
- **Campos de negócio**: `amount`, `currency`, `externalTransactionId`,
  `gameId`, `kind`, `playerId`, `providerId`,
  `referenceExternalTransactionId`, `roundId`, `walletId`.
- **`kind` participa**: a unique de idempotência é global por
  `(providerId, idempotencyKey)`, então a mesma chave usada para operações
  de tipos diferentes é **conflito**, nunca replay (§9: "mesma key com
  payload diferente → conflito").
- **Ausência é `null` explícito**: o contrato exige todos os campos; um
  valor `undefined` em runtime também é normalizado para `null`.
- **O header `Idempotency-Key` e metadados de transporte não entram** no
  hash — o tipo `WagerPayload` nem os aceita (garantia de tipo, coberta por
  teste).
- Formato do campo persistido: 64 caracteres hexadecimais minúsculos
  (coluna `payload_hash varchar(64)`).

Regras derivadas: requisição idêntica ⇒ mesmo hash ⇒ replay com
`idempotentReplay: true`; mesma chave com qualquer campo de negócio
diferente (inclusive `kind`) ⇒ hash diferente ⇒ conflito.

## Estrutura
```
src/domain/          Money, Wallet, WalletLedgerEntry, WagerTransaction (sem NestJS/ORM/SQS)
src/application/     OpenWalletUseCase, ProcessBetUseCase, ProcessWinUseCase,
                     ResolvePendingReferencesUseCase (+ process-support, reference-retry-policy)
src/infrastructure/  entidades e repositórios MikroORM + workers/pending-reference.worker.ts
src/migrations/      Migration20261024021931_InitialSchema (constraints + ledger append-only)
                     Migration20261024150000_PendingReferenceRetry (tentativas, janela e índices do §7.1)
test/support/        fake de EntityManager (apenas unitários)
test/integration/    suíte contra PostgreSQL e LocalStack reais
```

## Worker de referências pendentes (§7.1)
Toda `WIN` com `referenceExternalTransactionId` cujo alvo ainda não existe
fica `PENDING_REFERENCE` e é reprocessada por um worker agendado:

- **Política**: backoff `5 s × 2^(tentativa−1)` com teto de 15 min, no
  máximo **10 tentativas** (≈ 51 min) e **TTL absoluto de 6 h** a partir de
  `created_at`. Os dois limites são verificados independentemente; esgotado
  qualquer um → `REJECTED` + `REFERENCE_NOT_FOUND` + evento
  `WagerTransactionRejected`, tudo na mesma transação.
- **Concorrência**: claim com `FOR UPDATE SKIP LOCKED`, tentativa contada
  durante o claim, lock da wallet e releitura dentro da transação
  financeira — duas instâncias nunca aplicam duas vezes.
- **Agendamento**: `setInterval` do próprio NestJS (sem `@nestjs/schedule`).

Variáveis (`.env.example`):

| Variável | Padrão | Efeito |
|---|---|---|
| `PENDING_REFERENCE_POLL_MS` | `5000` | intervalo entre ciclos em ms; mínimo 100, valor inválido cai no padrão |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | `false` não agenda o worker neste processo |

## Publicação da outbox (§11)
O evento nasce na mesma transação dos efeitos financeiros (comprovado pelos
testes de rollback). Este incremento acrescenta a **publicação**: um worker
varre `outbox_messages`, publica cada evento em SQS e marca `PUBLISHED`:

- **fila dedicada**: os eventos saem em `wager-events.fifo`
  (`SQS_EVENTS_QUEUE_URL`), separada da fila de **comandos**
  `wager-transactions.fifo` (§10) e da DLQ dela; ambas são FIFO;
- claim com `FOR UPDATE SKIP LOCKED`, tendo a tentativa contada e a próxima
  janela gravadas **antes** de publicar — uma queda entre o claim e a
  publicação deixa a mensagem elegível de novo, sem perder;
- corpo da mensagem = payload gravado na outbox, sem reescrita;
- falha de publicação vira retentativa com o backoff já adotado (5 s ×
  2^(n−1), teto 15 min), limitada a 10 tentativas — esgotadas, a mensagem
  continua na tabela, auditável e **sem** estado novo nem fila morta;
- desligamento gracioso: o timer para e o ciclo em andamento é aguardado.

Variáveis (`.env.example`):

| Variável | Padrão | Efeito |
|---|---|---|
| `OUTBOX_POLL_MS` | `5000` | intervalo entre ciclos em ms; mínimo 100, valor inválido cai no padrão |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | `false` não agenda o publisher neste processo |
| `SQS_EVENTS_QUEUE_URL` | `wager-events.fifo` | fila de **eventos** da outbox (§11), dedicada e FIFO |

## Ambientes
Há dois ambientes Docker, totalmente separados em containers, volumes e portas:

| | Desenvolvimento | Integração |
|---|---|---|
| Arquivo | `compose.yaml` | `compose.integration.yaml` |
| Comando | `docker compose up -d` | `docker compose -p jungle-gaming-integration -f compose.integration.yaml up -d --wait` |
| PostgreSQL | `localhost:5432`, db `wagering` | `127.0.0.1:5433`, db `wagering_integration` |
| LocalStack | `localhost:4566` | `127.0.0.1:4567` |
| Filas | `wager-transactions.fifo` (comandos) + `wager-transactions-dlq.fifo` + `wager-events.fifo` (eventos da outbox) | `jungle-integration-wager-transactions.fifo` + `jungle-integration-wager-events.fifo` |

As portas de integração ficam amarradas a `127.0.0.1` e usam números
diferentes dos de desenvolvimento, então os dois ambientes convivem.

## Como executar

**Pré-requisitos:** Bun 1.x, Docker com Docker Compose (PostgreSQL e
LocalStack sobem em containers; nenhuma instalação local de banco é
necessária).

```bash
# 1. dependências
bun install

# 2. configuração — copiar o exemplo e ajustar se necessário
cp .env.example .env
```

Variáveis essenciais em `.env` (valores ilustrativos em `.env.example`):

| Variável | Papel |
|---|---|
| `DATABASE_URL` | PostgreSQL usado pela aplicação e pelas migrations |
| `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | acesso ao SQS (LocalStack aceita as credenciais `test`) |
| `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL` | fila de **comandos** (§10) e DLQ dela |
| `SQS_EVENTS_QUEUE_URL` | fila de **eventos** da outbox (§11) |
| `PENDING_REFERENCE_POLL_MS`, `OUTBOX_POLL_MS`, `WAGER_CONSUMER_POLL_MS` | intervalo dos três workers (mínimo 100 ms) |
| `PENDING_REFERENCE_WORKER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `WAGER_CONSUMER_ENABLED` | `false` desliga o respectivo worker no processo |

```bash
# 3. infraestrutura (desenvolvimento: PostgreSQL 5432 + LocalStack 4566)
docker compose up -d

# 4. migrations (usa o DATABASE_URL do .env)
bun --bun run migration:up

# 5. aplicação — API HTTP + os três workers
bun run start:dev

# produção
bun run build
bun run start:prod
```

**Health checks** (sem autenticação, §2 e §9):

```bash
curl http://localhost:3000/health/live    # processo vivo
curl http://localhost:3000/health/ready   # PostgreSQL e SQS alcançáveis
```

`/health/ready` responde `{"status":"ok","postgres":"ok","sqs":"ok"}` ou
**503** com qual dependência está inacessível.

**Encerrar:** `docker compose down` para o ambiente de desenvolvimento; para o
de integração, use sempre os mesmos nomes com que subiu
(`docker compose -p jungle-gaming-integration -f compose.integration.yaml down`).
Com `-v` a remoção de volumes atinge **só** o projeto indicado.

### Testes unitários
```bash
bun run test        # vitest, sem serviços externos
bun run lint
bunx tsc -p tsconfig.json --noEmit --incremental false
```

### Testes de integração
```bash
# 1. subir o ambiente isolado (apenas a primeira vez ou após encerrar)
docker compose -p jungle-gaming-integration -f compose.integration.yaml up -d --wait

# 2. executar — migrations rodam só no banco de integração
bun run test:integration

# 3. encerrar (sem -v preserva os volumes; com -v remove SÓ os volumes deste projeto)
docker compose -p jungle-gaming-integration -f compose.integration.yaml down
```

Nunca use `docker compose down -v` sem `-p jungle-gaming-integration` e sem
`-f compose.integration.yaml`: isso apagaria os volumes de desenvolvimento.

A suíte de integração se recusa a rodar se `INTEGRATION_DATABASE_URL` apontar
para um banco cujo nome não termine em `_integration`, antes de qualquer
conexão ou `TRUNCATE`. Variáveis e valores ilustrativos: `.env.integration.example`.

Ver `ARCHITECTURE.md` para o que a suíte de integração cobre hoje e o que
ainda falta para validar a publicação de eventos end-to-end.
