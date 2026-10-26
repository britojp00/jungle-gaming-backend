# Progresso — Jungle Gaming Backend

Registro histórico do trabalho desde a fundação. A cronologia é a ordem que
pôde ser **reconstruída a partir de evidências nos arquivos** — não de
histórico Git. Não atribuo datas ou horários que não estejam comprovados.

## Situação do versionamento
O trabalho está versionado — a fundação em `5068354` e a entrega final em
commits com arquivos explicitamente selecionados:

| Commit | Conteúdo |
|---|---|
| `4f507c6` | docs: adiciona planejamento inicial do desafio |
| `10381ba` | docs: adiciona instrucoes e skills do OpenCode |
| `e4d61ff` | chore: configura scaffold inicial NestJS com Bun |
| `5068354` | feat: implement distributed wagering processor (domínio, casos de uso, workers, HTTP, testes) |
| `9f9b595` | feat(wagering): regras 3/4 do §7 em REFUND/ROLLBACK e auditoria A1 |
| `f7f9a20` | feat(persistence): índice único de uma reversão processada por referência |
| `8817fe1` | test(integration): concorrência e redelivery entre processos independentes |
| (este) | docs: alinha README, plano, arquitetura, checklist e progresso à entrega final |

As datas comprovadas no corpo da implementação são os nomes das migrations:
`Migration20261024021931` ⇒ 2026-10-24 02:19:31 e
`Migration20261025120000`/`Migration20261025160000` ⇒ 2026-10-25. Todo o
trabalho descrito abaixo pertence a **2026-10-24/25**.

---

## Fase 1 — Fundação
Scaffold NestJS com Bun e TypeScript estrito, dependências e integração à
raiz do repositório. Único trabalho já commitado.

## Fase 2 — Ambiente de desenvolvimento
- `compose.yaml` com PostgreSQL 17 e LocalStack 4 (apenas SQS), healthchecks
  e volumes nomeados.
- `docker/localstack/init-queues.sh` cria `wager-transactions.fifo` e a DLQ
  com redrive policy via `awslocal`.
- `.env.example` com valores ilustrativos.

## Fase 3 — Persistência e schema
- `src/mikro-orm.config.ts` com `Migrator`.
- `src/migrations/Migration20261024021931_InitialSchema.ts`: tabelas
  `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`,
  `outbox_messages`, todas as CHECKs financeiras, índices, e o trigger
  `wallet_ledger_immutable` (`BEFORE UPDATE OR DELETE`) que torna o ledger
  append-only **no banco**. A migration tem caminho de reversão.
- Cinco entidades MikroORM em `src/infrastructure/persistence/entities/`.

## Fase 4 — Domínio financeiro
Ordem reconstruída pela cadeia de dependências e pelos arquivos de teste.

1. **`Money`** — imutável, `decimal.js`, entrada/saída como string de duas
   casas, moeda obrigatória.
2. **`Wallet`** — saldo e versão; `create` nasce em `version = 1`.
3. **`WalletLedgerEntry`** — imutável; `create` valida direção, valor
   positivo, saldos não negativos e `balanceBefore ± money === balanceAfter`;
   `rehydrate` sem revalidar; `isBalanced()` total.
4. **`WagerTransaction`** — enums de tipo e status; factory `createOpening`
   que exclui estruturalmente metadados de provedor.

### Decisões registradas nesta fase
- **`OPENING` nasce `PROCESSED` com `processedAt = createdAt`** (README 6.3 +
  9): é criada na mesma transação SQL da wallet e do ledger, então já nasce
  aplicada, e sendo interna não haveria worker a processá-la depois.
- **`OPENING` exige valor estritamente positivo** (README 9 só a dispara com
  saldo inicial > 0; o ledger exige `amount > 0`). Saldo zero não gera
  transação, ledger nem evento.
- **Abertura não chama `Wallet.credit()`**, que elevaria a versão para 2 e
  contradiz a resposta documentada no README 9.
- **`isBalanced()` retorna `false` (não lança)** em divergência de moeda,
  para permanecer uma consulta total usável em reconciliação.
- **`rehydrate` não revalida** (README 6.0); a integridade vem das CHECKs do
  banco.

### Enums domínio ⇄ infraestrutura
As entidades passaram a **importar e re-exportar** os enums do domínio em vez
de redeclará-los. Só havia uso como anotação de tipo, então não houve impacto
runtime nem necessidade de migration nova.

## Fase 5 — `OpenWalletUseCase`
Criação atômica de wallet + `OPENING` + ledger `CREDIT` + evento
`WalletBalanceChanged` em uma única `em.transactional` com um único `flush`.
Saldo zero grava só a wallet. Duplicidade tratada em dois níveis:
pré-checagem para falhar cedo **e** captura de
`UniqueConstraintViolationException` — esta é a garantia real sob corrida.

### Problema encontrado e resolvido — contrato do evento
Ambos os casos de uso emitiam `{ walletId, playerId, balanceBefore,
balanceAfter, walletVersion, transactionId }`, **divergindo do README §11**,
que define `WalletBalanceChangedData` com `direction` e `money` e **sem**
`playerId`. Os payloads foram alinhados ao contrato documentado.

Consequência: `ProcessBetUseCase` **não tinha nenhum teste**. Como era
necessário verificar o payload dos dois casos de uso, o fake de
`EntityManager` (~150 linhas) foi extraído para
`test/support/fake-entity-manager.ts` em vez de duplicado, e foi criado
`src/application/wagering/use-cases/process-bet.use-case.spec.ts`.

**Limitação assumida:** o fake modela apenas a orquestração. Rollback real,
concorrência entre instânicas e constraints do banco **não** eram cobertos
por ele — foi o que motivou a Fase 8.

## Fase 6 — Segurança monetária: arredondamento silencioso
Um teste com valor muito grande falhou e revelou o problema. Verificado
empiricamente com `bun`:

- o decimal.js **não arredonda na construção** a partir de string;
- **arredonda o resultado de `plus`/`minus`** para a precisão configurada
  (padrão: 20 dígitos significativos).

Com a precisão padrão, `999999999999999999.99 + 999999999999999999.99`
devolvia `2000000000000000000.00`, **perdendo centavos e dígitos inteiros**.

Correção em `src/domain/shared/value-objects/money.ts`:
- validação da faixa **na própria string**, antes de qualquer conversão;
- `Money.create` rejeita magnitude `>= 10^18` (compartilhado por criação e
  aritmética), então estouro vira erro de domínio;
- `Decimal.set({ precision: 21 })` — menor precisão compatível com
  `numeric(20,2)`: 20 dígitos para o maior valor válido + 1 para o carry.

Honestidade registrada: a precisão de 21 **não era estritamente necessária**,
porque todo valor dentro da faixa tem ≤ 20 dígitos significativos, então a
validação de faixa sozinha já rejeitaria o estouro. Ela foi adotada para que
a guarda avalie o **intermediário exato** em vez de um valor já arredondado,
removendo a dependência de uma invariante sutil. `Money` é o único consumidor
de decimal.js no projeto.

Também foi corrigido um teste anterior que, por semear um saldo menor que a
aposta, provocava rejeição em vez de debitar.

## Fase 7 — Harness de testes de integração
Ambiente totalmente separado do desenvolvimento:

- `compose.integration.yaml`: PostgreSQL em `127.0.0.1:5433` e LocalStack em
  `127.0.0.1:4567`, containers, volumes e portas próprios, em loopback.
- `test/integration/support/`: bootstrap do MikroORM, migrations aplicadas
  **só** no banco `wagering_integration`, truncate entre testes.
- `vitest.config.integration.ts` + `bun run test:integration`, em série.
- `test/integration/support/sqs.ts`: cliente HTTP mínimo com **SigV4** sobre
  `fetch` + `node:crypto`. O projeto **não tem o AWS SDK**, e esta etapa não
  instalou dependências nem inventou um publisher de produção.

### Três problemas reais encontrados
1. **Node 24 vs enums.** O MikroORM descobre entidades com `import()`
   dinâmico; o Node carregava esses `.ts` em *strip-only mode*, que rejeita
   `enum` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Corrigido com
   `server.deps.inline: [/@mikro-orm\//]` no config de integração.
2. **Rollback testado errado.** `tx.getConnection().execute()` roda em
   autocommit **fora** da transação, então o rollback não desfazia nada.
   Reescrito com `tx.persist()` + `tx.flush()` dentro de
   `em.transactional` — o mesmo caminho do código de produção.
3. **Vazamento para o banco de dev.** A config e2e ampla também capturava
   `test/app.e2e-spec.ts`, que conecta em `DATABASE_URL`. Por isso a suíte
   ganhou config própria e escopada.

### Verificações de comportamento executadas
- Rollback real e **limitado à transação**: o dado pré-existente sobrevive.
- Constraints reais: `wallets_balance_non_negative` e
  `wallets_player_currency_unique`.
- Trava anti-acidente: apontar `INTEGRATION_DATABASE_URL` para `wagering`
  derruba a suíte com recusa explícita **antes** de conectar.
- Falhas de conexão não são engolidas: `ECONNREFUSED` (PostgreSQL) e
  `fetch failed` (SQS).
- Isolamento: as filas de dev não existem no LocalStack de integração.
- Execução repetida idêntica em duas rodadas consecutivas.

### Achados pré-existentes, deixados como pendência
- **`bun run test:e2e` já estava quebrado** antes deste trabalho, pelo mesmo
  motivo dos enums (scaffold do NestJS). A correção é o mesmo bloco de
  `server.deps.inline`, já aplicado apenas no config de integração; o config
  e2e foi mantido **inalterado** para não mudar comportamento não solicitado.
- **`WalletRepository.create`** cria a wallet **sem** os registros financeiros
  obrigatórios e fora de transação. Não é usado pelos casos de uso atuais, mas
  é um caminho inseguro pendente de decisão.

---

## Fase 8 — Testes de concorrência real em PostgreSQL

Arquivos: `test/integration/concurrency.integration.e2e-spec.ts` (novo, 7
testes) e `test/integration/postgres.integration.e2e-spec.ts` (+1 teste do
trigger de append-only).

### Abordagem
- Cada "requisição" concorrente recebe um `EntityManager` próprio
  (`orm.em.fork()`) com conexão própria do pool: transações SQL
  verdadeiramente concorrentes contra o PostgreSQL real — sem mocks e sem
  execução sequencial disfarçada.
- Todo o estado asserted vem de SQL cru (fora do identity map), e toda a
  aritmética monetária usa `Money` com strings decimais. `number` não é
  usado para dinheiro em nenhum ponto.
- Invariante final aplicado em todos os cenários (README 13):
  `wallet.balance == saldo reconstruído pelo ledger`. A cadeia é
  reconstruída varrendo os lançamentos sem depender de ordenação por
  timestamp, e cada linha precisa satisfazer `before ± amount === after`.

### Cenários cobertos
1. Cenário obrigatório do README 8: apostas de 80,00 + 80,00 sobre saldo
   100,00 em paralelo → 1 `PROCESSED`, 1 `REJECTED`, saldo `20.00`, um
   único débito.
2. Cinco apostas de 80,00 concorrentes sobre 100,00 → exatamente 1 aprovada.
3. Mesma aposta enviada 50× em paralelo → 1 transação, 1 débito, saldo
   `90.00`, 49 replays do resultado original.
4. Mesma chave de idempotência com conteúdos diferentes na mesma wallet →
   `IDEMPOTENCY_PAYLOAD_CONFLICT`, 1 transação, 1 débito (o do vencedor).
5. Mesma chave de idempotência com conteúdos diferentes em wallets
   distintas → conflito, sem efeito parcial na wallet perdedora.
6. Cinco aberturas simultâneas da mesma wallet (mesmo jogador e moeda) →
   1 carteira, 1 `OPENING`, 1 `CREDIT`, 4× `WALLET_ALREADY_EXISTS`.
7. Apostas concorrentes em três wallets distintas → todas aprovadas, cada
   uma consistente.

Após **cada** cenário são verificados contra o banco: saldo nunca negativo,
cadeia do ledger íntegra, reconciliação saldo ⇄ ledger, soma
`credit − debit == saldo`, `REJECTED` sem lançamento, `version == 1 +
movimentações` e contagem exata de eventos na outbox (nada duplicado).

### Problema encontrado e corrigido nesta fase
O teste 5 **falhou na primeira execção**, com evidência real:

```
duplicate key value violates unique constraint "wager_transactions_provider_idempotency_unique"
```

Causa: requisições concorrentes com a mesma `(providerId, idempotencyKey)`
em wallets **diferentes** não se serializam no lock da carteira (a unidade de
concorrência é a `walletId`), então ambas passam pela pré-checagem `findOne`
e chegam ao `INSERT`; quem perde recebia o erro cru do PostgreSQL em vez de
`IDEMPOTENCY_PAYLOAD_CONFLICT`. A integridade financeira **não** foi
violada — a transação perdedora sofre rollback total —, mas o contrato sim:
o chamador não distingue conflito de idempotência de falha de infraestrutura
(na API HTTP seria 500 em vez de 409).

Correção mínima em `ProcessBetUseCase`: captura de
`UniqueConstraintViolationException` **fora** da transação (mesmo padrão já
usado pelo `OpenWalletUseCase`) no novo método `resolveConcurrentDuplicate`,
que relê a chave fora da transação abortada e devolve replay (hash igual),
conflito (hash diferente) ou propaga o erro original (outra constraint, ex.:
`external_transaction_id`). Após a correção, o teste passa.

### Também exercitado
- Trigger `wallet_ledger_immutable`: `UPDATE` e `DELETE` sobre lançamento
  existente são rejeitados pelo PostgreSQL ("Wallet ledger entries are
  immutable"). O ledger append-only está provado **no banco**, não apenas no
  domínio — item que constava como pendente nas fases anteriores.

### Decisão registrada
Os testes de concorrência usam `EntityManager` e conexões distintas dentro
de **um processo**. Múltiplas instâncias (≥3 processos) permanecem pendentes
e não são afirmadas como validadas; o item está detalhado em `PLAN.md` e em
`ACCEPTANCE_CHECKLIST.md` (risco eliminatório 5).

---

## Fase 9 — Contrato financeiro completo no domínio + hash canônico

Arquivos novos: `src/domain/wagering/failure-code.ts`,
`src/domain/shared/errors/invalid-transaction-state-error.ts`,
`src/application/wagering/payload-hash.ts` (+ spec). Alterados:
`src/domain/wagering/wager-transaction.ts` (+ spec expandido) e
`src/application/wagering/use-cases/process-bet.use-case.ts` (apenas a
extração do hash e a inclusão de `kind`, como aprovado).

### Auditoria — divergências encontradas antes de implementar
1. `WagerTransaction` só modelava `OPENING`: sem factories nem transições
   para os cinco kinds externos; `PENDING` e `PENDING_REFERENCE` existiam no
   enum e no CHECK do banco, mas eram inalcançáveis pelo domínio.
2. `roundId`/`gameId` existiam na entidade e na migration, mas não no
   domínio — a regra 2 ("mesma rodada") não era verificável.
3. `failureCode` não existia no domínio: só a coluna `rejection_reason` e a
   literal `'INSUFFICIENT_FUNDS'` no caso de uso. A §7.2 exige taxonomia
   documentada e a regra 9 exige código **distinto** para reversão que
   ficaria negativa.
4. `referenceTransactionId` (FK interna) existia no schema, mas não no
   domínio — `markProcessed(referenceTransactionId, at)` precisa dele.
5. O `hashPayload` do `ProcessBetUseCase` **não incluía `kind`** e não
   ordenava as chaves: a unique de idempotência é **global** por
   `(providerId, idempotencyKey)`, então a mesma chave usada para tipos
   diferentes resultaria em replay em vez de conflito (README §9), e o §9
   exige "JSON canônico (chaves ordenadas)".

Os trechos exatos do README (§3, 6.3, 7, 7.1, 7.2 e 9) foram apresentados
com as contradições aparentes antes de qualquer alteração, e o escopo foi
aprovado. Fonte de verdade: branch `main` de
`junglegaming/backend-challenge`.

### Decisões registradas
- **Uma factory por kind** (`createBet`, `createWin`, `createLoss`,
  `createRefund`, `createRollback`), não uma `create` genérica: a exigência
  de referência vira obrigação de tipo (REFUND/ROLLBACK) e impossibilidade
  estrutural (BET/LOSS), em vez de checagem esquecível.
- `roundId` e `gameId` **obrigatórios** nas cinco operações de provedor
  (README 6.3 + §3); `createOpening` continua sem eles por ser interna.
  Domínio mais estrito que o schema anulável — decisão aprovada.
- Valor **positivo** em todos os kinds; `LOSS` é informativa: não movimenta
  saldo (`affectsBalance() === false`) nem gera lançamento
  (`ledgerDirectionFor()` lança).
- Referência externa: **exigida** em REFUND/ROLLBACK (regra 1), **opcional**
  em WIN (§7), **proibida** em BET/LOSS (nenhuma regra a justifica —
  interpretação documentada).
- `FailureCode` com cinco códigos ligados a regras explícitas
  (`INSUFFICIENT_FUNDS`, `INSUFFICIENT_BALANCE_FOR_REVERSAL`,
  `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INTERNAL_ERROR`),
  persistido em `rejection_reason` — **nenhuma migration nova**.
- Transições kind-agnósticas; `markPendingReference()` repetida é no-op
  idempotente (o worker de §7.1 reavalia a cada ciclo).
- Hash canônico extraído para `payload-hash.ts`: SHA-256 hex minúsculo,
  chaves ordenadas, `kind` e `referenceExternalTransactionId` no subconjunto,
  campos obrigatórios (ausência = `null` explícito) e contrato de tipo que
  rejeita o header. Algoritmo documentado no `README.md` (§9 exige).

### Problema encontrado e corrigido durante os testes
O primeiro teste do hash **falhou**: com campos opcionais no contrato, uma
chave ausente e uma chave `null` produziam hashes diferentes. Correção:
`WagerPayload` passou a exigir todos os campos (ausência é sempre `null`
explícito) e a função normaliza `undefined` → `null` em runtime; o teste
reescrito cobre as duas formas. Nenhum teste foi enfraquecido.

### Decisão pendente registrada (não implementada)
Se um `WIN` chegar com `referenceExternalTransactionId` cuja BET ainda não
exista: virar `PENDING_REFERENCE` (regra 8 + §7.1) ou processar
imediatamente? O texto do README não resolve o caso. As transições do
domínio ficaram **kind-agnósticas** justamente para não decidir aqui; a
política está registrada como pendente em `ARCHITECTURE.md` para a etapa
dos casos de uso. **(Resolvida na Fase 11, abaixo: `PENDING_REFERENCE`.)**

### Limites de escopo respeitados
- `ProcessBetUseCase` não mudou de comportamento além da extração do hash e
  da inclusão de `kind`; continua construindo a entidade cru (sem passar por
  `createBet`) — alinhar é pendência da etapa dos casos de uso. **(Feito na
  Fase 10, abaixo.)**
- Nenhuma migration nova e nenhuma alteração de schema: todas as validações
  da factory cabem nas constraints existentes (verificado campo a campo
  contra a migration antes de escrever o código).
- Nenhum caso de uso WIN/LOSS/REFUND/ROLLBACK, nenhum worker, nenhuma HTTP.
- Banco de desenvolvimento conferido (leitura): `wager_transactions` com 0
  linhas — a troca de algoritmo do hash não invalida nenhum dado persistido.

---

## Fase 10 — Integração do domínio ao `ProcessBetUseCase`

### Auditoria — contrato oficial antes de alterar
- README 6.3 tipa `roundId` e `gameId` como `string` não anuláveis no
  construtor de `WagerTransaction`; §9 traz os dois no corpo de
  `POST /wagering/transactions`; §10 os traz na mensagem SQS; §3 define
  operações associadas a uma rodada. **Conclusão: BET sem esses campos é
  payload inválido.** Não há contradição com o contrato oficial — a
  decisão foi rejeitá-las explicitamente, em três camadas: tipo
  obrigatório em `ProcessBetInput`, `INVALID_ROUNDID`/`INVALID_GAMEID`
  na validação da aplicação e a própria factory `createBet`.
- O esqueleto oficial dá a `reject(code)` **sem parâmetro de data** —
  apenas `markProcessed(ref, at)` recebe `at`. Logo uma transação
  `REJECTED` não tem `processedAt`.

### Alterações
- `process-bet.use-case.ts`: a BET agora nasce por
  `WagerTransaction.createBet` **antes** de tocar o banco (campos,
  limites de coluna, formato do hash e valor positivo validados no
  domínio); dentro da transação, `markProcessed(undefined, now)` quando
  há saldo ou `reject(FailureCode.INSUFFICIENT_FUNDS)` quando não há; a
  entidade passa a ser montada pelo mapeador `toEntity`, no mesmo formato
  do registro de abertura do `OpenWalletUseCase`; a literal
  `'INSUFFICIENT_FUNDS'` foi substituída por
  `FailureCode.INSUFFICIENT_FUNDS` (valores persistido e de evento
  inalterados).
- `roundId` e `gameId` deixaram de ser opcionais em `ProcessBetInput`.

### Comportamento alterado (alinhamento ao contrato oficial)
- `processed_at` passa a ficar **nulo** em BET rejeitada (antes era
  preenchido com o instante da transação), porque `reject(code)` do
  esqueleto oficial não recebe data. Coberto por teste unitário e de
  integração.

### Testes
- Unitários: +7 — roundId/gameId persistidos pela factory; cada campo
  ausente e em branco; validações da factory antes do banco; saldo
  insuficiente com `FailureCode` centralizado (resultado, coluna e
  evento); replay idempotente sem efeitos duplicados; conflito de
  payload sem efeito algum.
- Integração: +1 — payload sem roundId/gameId recusado sem efeito no
  banco; o cenário do §8 também passou a asserir `round_id`/`game_id`,
  `rejection_reason` e `processed_at`.

### Limites de escopo respeitados
- Nenhum caso de uso WIN/LOSS/REFUND/ROLLBACK, nenhum HTTP, nenhum
  publicador SQS.
- Algoritmo de hash inalterado: `roundId`/`gameId` agora são sempre
  string na entrada válida, e a ramificação `?? null` foi removida por
  ficar inalcançável — mesmos bytes para payloads aceitos.
- Nenhuma migration nova.

---

## Fase 11 — Resolução da política de referência do `WIN` (decisão, sem código)

### O que foi feito
- Relido o README oficial separando requisitos explícitos de decisões de
  projeto: §3 (entrega at-least-once e chegada fora de ordem), §7 (tabela
  de operações, regras 1–9), §7.1 (referências fora de ordem), §7.2
  (taxonomia), §9 (resposta "aceite com processamento pendente"), §11
  (evento `WagerTransactionPendingReference`) e 6.3 (status e
  transições).
- Verificada a migration atual quanto a divergências de schema: a CHECK
  `wager_transactions_reversal_reference_required` não exige a FK interna
  e a unique parcial cobre só `REFUND`/`ROLLBACK` — **`PENDING_REFERENCE`
  com `reference_transaction_id` nulo é válida para qualquer kind; nenhuma
  divergência concreta, nenhuma migration**.
- Decisão registrada em `ARCHITECTURE.md` (seção "Decisão — política de
  referência do `WIN`", com a tabela de trechos citados) e resumida em
  `PLAN.md` (seção "Decisão registrada"). **Nenhuma linha de código,
  migration ou teste alterada.**

### Decisão
- `WIN` **sem** `referenceExternalTransactionId` → aplica imediatamente
  (`PENDING → PROCESSED`, crédito) — exigido pela própria tabela §7.
- `WIN` **com** referência cujo alvo ainda não existe →
  `PENDING_REFERENCE` + evento `WagerTransactionPendingReference`, sem
  saldo nem ledger; worker agendado reprocessa (§7.1); esgotado o limite →
  `REJECTED` + `REFERENCE_NOT_FOUND` + evento.
- Alvo **existe** (qualquer status) → resolve e credita; alvo existente em
  violação da regra 2 → `REJECTED` + `REFERENCE_MISMATCH`.
- Replay de `WIN` pendente → devolve o resultado original armazenado,
  sem resolver.

### Classificação honesta
O README **não nomeia o `WIN`** no fluxo de referência atrasada. A decisão
aplica as regras 8 e §7.1, que **não qualificam kind algum** (as regras 1,
3, 4 e 5 nomeiam) — logo é **decisão de projeto sobre texto não
qualificado**, não exigência textual que nomeie o `WIN`. A alternativa
(imediata) exigiria inventar uma exceção à regra 8 que o contrato não
estabelece; optou-se pela leitura que **não acrescenta regra**. O §13, item
7, cita só `ROLLBACK`/`REFUND` fora de ordem — lista de testes mínimos, não
taxonomia de comportamentos. Interpretou-se como o §7 manda: "qualquer
interpretação adicional adotada deve ser documentada".

### Consequências registradas para o caso de uso
- `ProcessWinUseCase` com duas rotas: crédito imediato (modelo:
  `ProcessBetUseCase`) e aceite pendente, com evento novo na outbox
  (ainda inexistente no código) e sem `WalletBalanceChanged`.
- Lock de wallet vale nas duas rotas; igualdade de valor (regra 5) e
  pertinência (regra 2) são do caso de uso.
- Limite de tentativas/TTL ficou **delegado ao README** (§7.1: "definido
  e justificado por você") e será escolhido na etapa do worker; para lá
  ficaram também, a presentar antes de qualquer migration, as colunas de
  tentativas (se não usar TTL por `created_at`) e o índice de varredura
  sobre `reference_external_transaction_id`.

### Limites de escopo respeitados
- Nenhum código, migration, teste ou dependência alterados; nenhum commit;
  nenhum comando destrutivo; banco intocado (etapa é documental).

---

## Fase 12 — `ProcessWinUseCase` (crédito, referência e eventos)

### Referência local do README oficial
O README oficial passou a ser lido de `docs/README-official.md` (cópia
criada na etapa anterior a partir de
`https://raw.githubusercontent.com/junglegaming/backend-challenge/main/README.md`:
HTTP 200, 27.497 bytes, 746 linhas, SHA-256
`47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e`,
byte a byte idêntico ao baixado, commit `c7143e6d041585d6913f56eb7415105e074f83dc`
da branch `main`, obtido em 24/10/2026). **Nesta etapa o arquivo não foi
rebaixado nem modificado.**

### Alterações
- `src/application/wagering/process-support.ts` — a máquina compartilhada
  criada na etapa anterior passou a ser **consumida**.
- `src/application/wagering/use-cases/process-bet.use-case.ts` — refactor
  para delegar ao suporte: removidos os privados `validateInput`,
  `toEntity`, `toResult`, `persistOutboxEvent` e
  `resolveConcurrentDuplicate`; `ProcessBetResult` virou alias de
  `WagerProcessResult`. **Comportamento idêntico** (a suíte existente da
  BET continua verde, sem nenhuma asserção alterada).
- `src/application/wagering/use-cases/process-win.use-case.ts` — **novo**,
  com `resolveReference` privado.
- `src/application/wagering/use-cases/process-win.use-case.spec.ts` —
  **novo**, 12 testes unitários.
- `test/integration/win.integration.e2e-spec.ts` — **novo**, 10 testes com
  PostgreSQL real.
- `test/support/fake-entity-manager.ts` — `findOne` passa a modelar o
  **filtro por PK de relação** (`{ wallet: id }`), como o MikroORM real
  compara o FK da coluna em vez do objeto referência.

### Comportamento implementado
- **Validação antes do banco e antes do lock:** campos obrigatórios
  (`INVALID_<CAMPO>`), referência presente mas em branco →
  `INVALID_REFERENCEEXTERNALTRANSACTIONID` (ausente não é erro),
  `Money.from` + valor estritamente positivo (`WIN amount must be positive`).
- **Ordem:** hash (com `kind: WIN` e referência normalizada) →
  `WagerTransaction.createWin` no domínio → `transactional` → lock da
  wallet → rechecagem da chave → resolução da referência.
- **Três desfechos** (decisão da Fase 11), todos numa única transação SQL:
  1. sem referência / referência resolvida → `wallet.credit`,
     `markProcessed(targetId?, now)`, ledger `CREDIT`,
     `WagerTransactionProcessed` + `WalletBalanceChanged` (`CREDIT`);
  2. alvo inexistente → `markPendingReference()` +
     `WagerTransactionPendingReference`, **sem** saldo, ledger ou
     `WalletBalanceChanged`; retorno `PENDING_REFERENCE`;
  3. alvo existente em violação da regra 2 → `reject(REFERENCE_MISMATCH)` +
     `WagerTransactionRejected`, sem saldo nem ledger.
- **Resolução** (`resolveReference`) só por coluna/filtro de PK:
  `(providerId, externalTransactionId)` → sem linha, mesmo
  `externalTransactionId` em outro provider é `REFERENCE_MISMATCH`, nenhuma
  linha é "referência inexistente"; com linha conferem-se `playerId`,
  `currency`, `roundId` e `wallet` (filtro `{ wallet: id }`). **Sem
  checagem de status**, como decidido.
- **Replay** (processada ou pendente) devolve o resultado original sem
  resolver referência; conflito de payload → `IDEMPOTENCY_PAYLOAD_CONFLICT`;
  corrida entre wallets distintas → `resolveConcurrentDuplicate`.

### Payload do evento pendente (aprovado — "Opção A")
Envelope da §11 (`aggregateId = transactionId`, `correlationId =
correlationId ?? transactionId`, `occurredAt` ISO, `version: 1`) com
`data = { transactionId, playerId, walletId, kind: "WIN", status:
"PENDING_REFERENCE", amount: MoneyProps, referenceExternalTransactionId }`
— **sem** `balance`/`walletVersion`, porque nada foi aplicado. Asserção
exata do payload no unitário e no PostgreSQL real.

### Testes executados nesta fase
- **Unitários (12 novos):** WIN sem referência (crédito, `CREDIT`,
  `PROCESSED`, eventos e contrato de `WalletBalanceChanged`); validações
  antes do banco; referência inexistente (`PENDING_REFERENCE`, outbox com o
  payload aprovado, zero efeito de saldo); replay de WIN pendente que **não**
  resolve; referência compatível com FK interna; **divergência em cada
  vínculo da regra 2** (provider, player, wallet, moeda, rodada →
  `REFERENCE_MISMATCH`); replay de WIN processada; mesma chave com payload
  diferente.
- **Integração PostgreSQL real (10 novos):** crédito; validação sem efeito;
  `PENDING_REFERENCE` com payload serializado pelo banco; replay pendente
  mesmo após a referência chegar; resolução da BET com FK interna;
  divergência de rodada; **duas requisições concorrentes idênticas** com um
  único crédito; conflito sem efeito parcial; **falha forçada após o
  `flush` da outbox → rollback real** de saldo, ledger, transação e outbox
  (proxy no `EntityManager`); e o reenvio da mesma WIN após a falha
  aplicando normalmente. O invariante final
  `wallet.balance == saldo reconstruído pelo ledger` (+ cadeia, soma,
  versão e outbox) roda em **todos** os cenários.

### Limites de escopo respeitados
- Somente `ProcessWinUseCase` e seus testes (+ o refactor de delegates da
  BET, sem mudança de comportamento). **Nada** de LOSS, REFUND, ROLLBACK,
  worker, publisher SQS ou HTTP; **nenhuma migration** (o schema comporta a
  decisão, como verificado na Fase 11); README oficial não modificado;
  nenhum commit.

---

## Fase 13 — Worker de recuperação de `PENDING_REFERENCE` (README §7.1)

Executada em seis etapas verificáveis (E1 migration → E2 política →
E3 extração → E4 caso de uso + integração → E5 worker no módulo → E6 docs),
cada uma só dada por concluída depois de `tsc`, `lint`, unitários e
integração verdes.

### Alterações

**E1 — migration e entity**
- `src/migrations/Migration20261024150000_PendingReferenceRetry.ts` —
  `reference_attempts int NOT NULL DEFAULT 0` + CHECK `>= 0`,
  `reference_next_attempt_at timestamptz NOT NULL DEFAULT now()`, índice
  parcial `wager_transactions_pending_reference_idx (reference_next_attempt_at,
  id) WHERE status = 'PENDING_REFERENCE'` e índice
  `wager_transactions_external_id_idx (external_transaction_id)`, com `down()`
  reversível.
- `src/infrastructure/persistence/entities/wager-transaction.entity.ts` —
  2 propriedades, 1 CHECK e 2 `@Index` (um deles com `where` parcial).

**E2 — política**
- `src/application/wagering/reference-retry-policy.ts` (+ spec, 11 testes) —
  módulo puro que é o único dono dos números: `referenceRetryDelayMs`,
  `nextReferenceAttemptAt`, `hasExhaustedReferenceAttempts`,
  `isReferenceRetryExpired`, `shouldRejectMissingReference`.

**E3 — extração**
- `src/application/wagering/process-support.ts` — `resolveReference`,
  `ReferenceCriteria`, `ReferenceResolution` e `applyTransactionState`
  passam a ser compartilhados; `ProcessWinUseCase` delega (o método privado
  saiu), sem mudança de comportamento.

**E4 — caso de uso e testes**
- `src/infrastructure/persistence/repositories/wager-transaction.repository.ts` —
  `claimPendingReferences` (SQL crudo com `FOR UPDATE SKIP LOCKED`) e
  `recordReferenceAttempt`.
- `src/application/wagering/use-cases/resolve-pending-references.use-case.ts`
  (+ spec, 11 testes) — claim, aplicação por linha, 5 desfechos, eventos.
- `test/integration/pending-reference.integration.e2e-spec.ts` — 8 cenários
  com PostgreSQL real.
- `test/support/fake-entity-manager.ts` — `claimRows`, `executed`,
  `execute()` e `nativeUpdate()`.

**E5 — worker**
- `src/infrastructure/workers/pending-reference.worker.ts` (+ spec, 12
  testes) — provider NestJS com `onModuleInit`/`onModuleDestroy`, um
  `setInterval`, guarda de sobreposição e log estruturado.
- `src/app.module.ts` — registro do provider.
- `.env.example` — `PENDING_REFERENCE_POLL_MS` e
  `PENDING_REFERENCE_WORKER_ENABLED`.

**E6 — docs**
- `ARCHITECTURE.md`, `PLAN.md`, `ACCEPTANCE_CHECKLIST.md`, `README.md` e
  este arquivo — lacunas de schema e a ausência do worker, que os documentos
  registravam como pendência, foram substituídas pelo que está implementado
  e medido.

### Política definida (§7.1 delega "limite de tentativas ou TTL")

| Parâmetro | Valor | Justificativa |
|---|---|---|
| base / fator | 5 s × 2^(tentativa−1) | backoff exponencial pedido pela §7.1; entrega fora de ordem se resolve em segundos |
| teto de espera | 15 min | mantém a reavaliação dentro do mesmo dia útil |
| tentativas | 10 | 5+10+20+40+80+160+320+640+900+900 s = 3.075 s ≈ **51 min** |
| TTL absoluto | 6 h | rede de segurança independente do contador: cobre downtime longo do worker sem reter transação indefinidamente |

§7.1 pede limite **ou** TTL; os dois são checados **independentemente**:
tentativas limitam a rajada, TTL limita a idade da pendência.

**Ajuste obrigatório 1 — TTL independente da janela de retry.** A única
condição de elegibilidade do claim é `reference_next_attempt_at <= ?`
(coluna indexada). A janela é `min(now + backoff, created_at + TTL)`, então
vencido o TTL ela cai no passado e a linha fica elegível a cada tick.

**Ajuste obrigatório 2 — claim concorrente.** `FOR UPDATE SKIP LOCKED` +
re-leitura **depois** do lock da wallet + transação financeira por linha;
a tentativa é contada **durante** o claim. Idempotência multi-instância em
três camadas, nenhuma dependente de SQS.

**Ajuste obrigatório 3 — crash após o claim.** O bump e a janela são
gravados na transação do claim, que é **separada** da financeira: um crash
depois dela consome a tentativa e deixa a janela futura escrita — a pendência
não se perde e não nasce ciclo imediato. Crash **dentro** do claim grava
nada. Registrado no repositório, no caso de uso e em `ARCHITECTURE.md`.

**Ajuste obrigatório 4 — saldo observado.** A resolução credita, grava
`result_balance_*`/`result_wallet_version` atualizados e os eventos com o
saldo novo, tudo no mesmo commit.

**Ajuste obrigatório 5 — anomalia ≠ `REFERENCE_NOT_FOUND`.** Linha
`PENDING_REFERENCE` sem referência/provider/rodada é
`FAILED` + `FailureCode.INTERNAL_ERROR` + problema estruturado
`UNRESOLVABLE_STATE` **sem evento** (§11 não define evento para falha de
infraestrutura); estado terminal auditável.

**Ajuste obrigatório 6 — rejeição atômica.** Limite ou TTL esgotado →
`REJECTED` + `REFERENCE_NOT_FOUND` + `WagerTransactionRejected` na mesma
transação, sem saldo.

**Ajuste obrigatório 7 — consistência.** Saldo, ledger, transação e outbox
seguem no mesmo commit; nada é publicado antes dele (continua não havendo
publisher).

**Ordem dentro de `applyRow`:** lock da wallet → releitura (terminal →
`skipped`) → guards → `resolveReference` → crédito/mismatch → **só então**
limite/TTL. Quem chega depois resolve mesmo com o TTL vencido: rejeitar
descartaria transação recuperável.

### Migration validada no banco de integração
`bun --bun run migration:up` com `DATABASE_URL` do banco isolado
(`wagering_integration`, 127.0.0.1:5433) → colunas/índices presentes;
`migration:down` → colunas, índices e CHECK removidos (contagens 0);
`migration:up` de novo → tudo restaurado; `migration:pending` = 0.

**Medição em 200.000 linhas** (justificativa do índice parcial): claim com
índice 0,296 ms / 42 buffers vs 28,46 ms / 6.377 buffers sem ele; fallback
`external_transaction_id` com índice 0,059 ms / 4 buffers vs 20,03 ms /
6.351 buffers (seq scan). Dados removidos após a medição.

### Problemas encontrados e corrigidos durante a validação

1. **Relógio fixo do teste contra `now()` do banco (8 de 8 cenários
   falhando com `claimed: 0`).** O `T0` era uma constante
   (`2026-10-24T12:00Z`), mas a janela inicial vem de `now()` do INSERT, e o
   relógio real já era posterior a `T0` — logo nenhuma linha era elegível.
   Cada teste agora captura o seu `t0 = new Date()` **depois** de criar as
   linhas; todos os deslocamentos são relativos a `t0`, sem dependência de
   relógio de parede. Foi o próprio teste que pegou a premissa errada — o
   código de produção estava correto.
2. **`timestamptz` cru volta como string do Postgres**
   (`2026-10-25 02:12:18.68+00`), não como `Date`. No repositório isso
   alimenta o TTL, então `toReferenceDate()` normaliza para ISO-8601 (`T` +
   offset `+HH:MM`) e estoura `REFERENCE_CREATED_AT_INVALID` em vez de
   seguir com `Invalid Date`; o teste usa a mesma normalização (`dateOf`).
   Verificado que o formato literal parseia em V8/Bun, mas o offset sem
   dois-pontos não — por isso a normalização explícita.

### Testes executados nesta fase
- **Unitários (34 novos):** 11 da política (delays, saturação do teto,
  esgotamento, TTL, `shouldRejectMissingReference`), 11 do caso de uso
  (claim, os 5 desfechos, evento `WagerTransactionRejected` por limite e por
  TTL, anomalia, falha por linha, falha do claim, replay terminal) e 12 do
  worker (configuração do poll, ciclo, logs estruturados sem payload
  financeiro, guarda de sobreposição, agenda/para/desabilita).
- **Integração PostgreSQL real (8 novos):** referência que chega depois +
  replay terminal; backoff com janela em `reference_next_attempt_at` (fora
  da janela não reprocessa, dobra 5 s → 10 s → 20 s); esgotamento das 10
  tentativas → `REFERENCE_NOT_FOUND`; TTL vencido sem esperar a janela;
  **duas instâncias concorrentes na mesma linha com um único crédito**;
  **lote de 4 linhas drenado por 2 workers**, cada linha exatamente uma vez;
  crash antes do commit (tudo desfeito, pendência preservada, próxima
  tentativa só na janela) e crash depois do commit (estado completo, o
  próximo ciclo não reaplica). O invariante
  `wallet.balance == saldo reconstruído pelo ledger` roda em todos.

### Limites de escopo respeitados
Apenas o worker de §7.1. **Nada** de LOSS, REFUND, ROLLBACK, HTTP, publisher
SQS, inbox, DLQ ou `@nestjs/schedule`. `docs/README-official.md` não foi
alterado. Nenhum commit, nenhum `git reset`/`git clean`, nenhuma operação
fora dos bancos isolados.

---

## Correções da auditoria da Fase 13

Auditoria somente de leitura do worker de §7.1 (achados classificados por
gravidade). Desta etapa saíram **duas correções de defeito comprovado** e a
documentação correspondente — nenhuma funcionalidade nova.

### A. Auto-referência de `WIN`

Uma `WIN` com `referenceExternalTransactionId` igual ao próprio
`externalTransactionId` fazia `resolveReference` encontrar **a própria
linha** e creditar a si mesma (`reference_transaction_id = id`, ledger
`CREDIT`, eventos) — quando a referência não existe e nunca existirá:
`(provider_id, external_transaction_id)` é único. Violava §7, regra 2 e a
tabela §7 (a `WIN` referencia a `BET` da mesma rodada) e pressupunha uma
resolução que a §7.1 nem contempla.

Correção: `resolveReference` ganhou `excludeId` e descarta a própria linha
nas duas consultas (por provider e o fallback). Auto-referência passa a ser
**referência ausente** (§7, regra 8): `PENDING_REFERENCE` → §7.1 →
`REJECTED` + `REFERENCE_NOT_FOUND`, sem efeito de saldo.

### B. Inconsistências persistentes em retry infinito

`WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` eram lançados, capturados
pelo `catch` por linha como `PROCESSING_FAILED` e reivindicados a cada
janela **para sempre** — nunca atingindo o estado que o README §6.3 define
para o caso (`FAILED`, erro permanente de infraestrutura, terminal e
auditável). `wallets.player_id` e a moeda da wallet não mudam depois da
abertura e são conferidos na entrada da WIN, então a divergência não se
corrige esperando.

Correção: os dois casos terminam pelo mesmo caminho da anomalia de estado
(`FAILED` + `INTERNAL_ERROR` + problema `UNRESOLVABLE_STATE` com
`missing: 'player_id'`/`'currency'`), **sem evento** (§11 não prevê evento
para falha de infraestrutura). `WALLET_NOT_FOUND` e
`REFERENCE_RESOLUTION_WITHOUT_TARGET` continuam lançando erro: guardas de
programação inalcançáveis (FK `on delete restrict` em `wallet_id`; a
política de resolução só devolve alvo com linha) e o primeiro sustenta o
teste de isolamento de falha por linha.

### Arquivos alterados
- `src/application/wagering/process-support.ts` — `excludeId` em `resolveReference`.
- `src/application/wagering/use-cases/resolve-pending-references.use-case.ts` — vínculo wallet ↔ transação virou `inconsistent` (helper `failUnresolvable`) e a resolução recebe `entity.id`.
- `src/application/wagering/use-cases/process-win.use-case.ts` — a resolução recebe `win.id` (no-op na entrada: a linha ainda não existe).
- `resolve-pending-references.use-case.spec.ts` (+4) e `pending-reference.integration.e2e-spec.ts` (+2): auto-referência e vínculo corrompido, verificando status, saldo, ledger, outbox e replay; `assertWalletLedgerConsistency` passou a exigir que `FAILED` não tenha lançamento.
- `ARCHITECTURE.md`, `ACCEPTANCE_CHECKLIST.md`, `PROGRESS.md` — comportamento documentado e contagens corrigidas.

### Testes executados nesta etapa
- **Unitários (4 novos):** auto-referência segue pendente sem crédito/ledger/evento e termina `REJECTED` + `REFERENCE_NOT_FOUND` no limite; player/moeda divergentes → `FAILED` + `INTERNAL_ERROR` + `UNRESOLVABLE_STATE`, sem efeito financeiro, e o ciclo seguinte **pula** a linha (fim do retry infinito).
- **Integração PostgreSQL real (2 novos):** os mesmos cenários contra o banco, com a linha de vínculo corrompido via SQL (a entrada impede esse dado), status/saldo/ledger/outbox conferidos e o ciclo seguinte com `claimed: 0`.

Limites respeitados: nada de publisher/relay de outbox, SQS, HTTP, LOSS,
REFUND, ROLLBACK, autenticação, observabilidade nova ou refatoração geral;
`docs/README-official.md` intacto; nenhum commit, nenhum `git reset`/`git
clean`, nenhuma operação fora do banco de integração isolado.

---

## Incremento — Transactional Outbox + publisher SQS (README §11)

Autorizado depois da análise de lacunas: a maior pendência de pontos era
"Mensageria e falhas" (15), quase toda vazia porque **nada era publicado** —
a outbox só era gravada. Este incremento implementa **apenas** a publicação.

### O que foi feito
- **Porta e transporte**: `src/application/messaging/outbox-publisher.ts`
  (porta `OutboxPublisher`), `src/infrastructure/sqs/sqs-client.ts` (cliente
  SQS SigV4 sobre `fetch`) e `sqs-outbox-publisher.ts` (`SendMessage`). Sem
  `@aws-sdk/*`: o projeto não tem SDK e dependências novas não eram
  permitidas — o transporte que a suíte já usava
  (`test/integration/support/sqs.ts`) foi promovido para produção e o
  harness passou a usá-lo (§13: os testes exercitam o código real).
- **Caso de uso** `PublishOutboxMessagesUseCase`: claim
  `FOR UPDATE SKIP LOCKED` numa transação curta, com **tentativa contada e
  janela gravadas antes de publicar** (mesmo mecanismo da §7.1), publicação
  fora da transação, e `PUBLISHED` + `published_at` ou `last_error` por
  mensagem.
- **Worker** `OutboxPublisherWorker`, no mesmo desenho do worker da §7.1, com
  **shutdown gracioso**: `onModuleDestroy` para o timer e aguarda o ciclo em
  andamento (§10 e §14).
- **Sem migration**: `outbox_messages` já tinha `status`, `attempts`,
  `next_attempt_at`, `last_error`, `published_at` e o índice
  `outbox_status_next_attempt_idx` (as colunas `locked_at`/`lock_owner` não
  são usadas — ver decisão 4).

### Decisões de contrato (pendentes de aprovação)
1. **Fila de destino** = `SQS_EVENTS_QUEUE_URL` → `wager-events.fifo` (FIFO),
   fila **dedicada** aos eventos da outbox — decisão **aprovada**. A §11 não
   nomeia destino; a fila de comandos (`wager-transactions.fifo`, §10) e sua
   DLQ seguem intactas. (Antes da decisão, a publicação usava
   `SQS_WAGER_QUEUE_URL`.)
2. **FIFO**: `MessageGroupId = aggregateId` (eventos do mesmo agregado
   preservam a ordem) e `MessageDeduplicationId = id do evento` — proteção
   **adicional** contra reenvio muito próximo, dentro da janela do broker.
   Não é a garantia final: o README (§8) trata deduplicação do broker como
   otimização, e a segurança de efeitos duplicados é do **consumidor**, via
   Inbox persistente (§10), que ainda não existe.
3. **Mensagem com tentativas esgotadas** (10, backoff `5 s × 2^(n−1)`, teto
   15 min) continua `PENDING` e deixa de ser reivindicada: nada se perde,
   tudo fica auditável, e **não** foi inventada semântica de fila morta nem
   estado novo.
4. `status = PROCESSING`, `locked_at` e `lock_owner` não são usados: o
   esqueleto oficial (§6.5) só prevê `isPending`/`isDue`/`markPublished`/
   `scheduleRetry`, e a janela gravada no claim já impede claim duplo sem
   deixar lock órfão.

### Correções da auditoria desta etapa
- **Shutdown ligado:** `main.ts` passou a chamar `app.enableShutdownHooks()`.
  Sem isso, o `onModuleDestroy` do `OutboxPublisherWorker` — que para o timer
  e aguarda o ciclo em andamento — **não** era acionado em SIGTERM/SIGINT
  (só via `app.close()`). Verificado no fonte do NestJS:
  `enableShutdownHooks` → `runShutdownSequence` → `callDestroyHook` →
  `onModuleDestroy` dos providers.
- **Redação corrigida:** a deduplicação FIFO do SQS passou a ser descrita como
  proteção **adicional** — o README (§8) é explícito em que recursos do broker
  são otimização, não a garantia final — e a segurança de efeitos duplicados
  fica registrada como tarefa do **consumidor**, com a Inbox persistente da
  §10 (fora desta etapa). "Exatamente uma vez" virou o que o teste comprova
  (sem claim duplo entre publishers concorrentes) e "byte a byte" virou "sem
  alteração de conteúdo" (a comparação é entre objetos JSON parseados).
- Comportamento financeiro, payloads, identificadores e o algoritmo de claim
  **não** foram alterados.

### Separação da fila de eventos (decisão aprovada)
A §11 não define destino para a publicação e `wager-transactions.fifo` é a
**entrada de comandos** da §10. Aprovou-se separar os fluxos:

- `SQS_WAGER_QUEUE_URL` continua apontando para `wager-transactions.fifo`
  (comandos), com sua DLQ intacta;
- **novo** `SQS_EVENTS_QUEUE_URL` → `wager-events.fifo`, fila FIFO
  **dedicada** aos eventos da outbox;
- `docker/localstack/init-queues.sh` provisiona as três filas, e o harness de
  integração cria `jungle-integration-wager-events.fifo` e **valida a
  separação**: os eventos aparecem na fila de eventos e nada cai na fila de
  comandos.

Arquivos: `.env.example`, `src/infrastructure/sqs/sqs-outbox-publisher.ts`
(destino por `SQS_EVENTS_QUEUE_URL`), `docker/localstack/init-queues.sh`,
`test/integration/support/env.ts`,
`test/integration/outbox-publisher.integration.e2e-spec.ts`,
`src/infrastructure/sqs/sqs-outbox-publisher.spec.ts` (cobertura da
configuração da fila), `README.md` e `ARCHITECTURE.md`.

Forma dos eventos, identificadores (`eventId`, `aggregateId`,
`MessageDeduplicationId`), SQL de claim, política de retry e lógica
financeira **inalterados**. Pendência de documentação fora do escopo
autorizado: `.env.integration.example` ainda só lista
`INTEGRATION_SQS_QUEUE_NAME`.

### Testes executados neste incremento
- **Unitários (21 novos):** claim (SQL, parâmetros, janela), payload
  publicado sem reescrita, `PUBLISHED`, falha → `last_error` + retentativa,
  lote parcial, limite de tentativas, claim falho não publica, janela gravada
  **antes** de publicar; e do worker: configuração do poll, ciclo, logs sem
  payload financeiro, sobreposição, agendamento/parada/desabilitado e
  **shutdown que aguarda o ciclo em andamento**.
- **Integração PostgreSQL + LocalStack reais (6 novos):** evento na mesma
  transação dos efeitos e o payload publicado **sem alteração de conteúdo**
  (a comparação é entre objetos JSON parseados); os **quatro**
  tipos de evento da §11 publicados; recuperação após interrupção **antes**
  da publicação; dois publishers concorrentes sem perda nem claim duplo;
  falha de publicação e retentativa; rollback financeiro sem nenhuma
  publicação.

Limites respeitados: nada de consumer SQS, Inbox, LOSS/REFUND/ROLLBACK, HTTP,
autenticação, métricas, observabilidade global ou refatoração geral;
`docs/README-official.md` intacto; nenhum commit, `git reset`/`git clean`,
reinstalação ou deploy; operações apenas no banco isolado de integração.

---

## Etapa 2 — Consumidor SQS com Inbox transacional (README §10 e §11)

### Estratégia transacional (regra arquitetural)
Inbox + operação financeira + ledger + outbox na **mesma** transação
PostgreSQL: o caso de uso abre uma transação, registra a Inbox e chama
`ProcessBetUseCase`/`ProcessWinUseCase` com o **mesmo** `EntityManager` — o
`transactional` interno deles vira savepoint na mesma conexão (MikroORM v7:
`TransactionManager.executeNestedTransaction` +
`AbstractSqlConnection.begin` com `ctx`; `commit`/`rollback` por
`releaseSavepoint`/`rollbackToSavepoint`). **Os casos de uso financeiros não
foram alterados.** O ack (`DeleteMessage`) só sai depois do commit; em
qualquer falha nada é confirmado — nem a própria Inbox.

### O que foi implementado
- envelope `WagerTransactionRequested` validado
  (`src/application/messaging/wager-transaction-requested.ts`);
- classificação de erro (§10, taxonomia documentada em `consumer-error.ts`):
  **negócio** (o caso de uso retorna, inclusive `REJECTED` → ack),
  **permanente** (envelope inválido e `IDEMPOTENCY_PAYLOAD_CONFLICT` → DLQ e,
  só então, ack) e **transitório** (sem ack → visibilidade do SQS e
  `maxReceiveCount` da fila);
- `ReceiveWagerTransactionUseCase` (Inbox + reuso de BET/WIN em uma
  transação) e `WagerCommandConsumerWorker` (poll, sobreposição, shutdown
  gracioso), com `SqsCommandQueue` (receive/ack/DLQ);
- harness de integração com DLQ e `RedrivePolicy`
  (`createQueueWithDeadLetter`).

### Decisões de contrato
`messageId` do envelope como identidade (com `consumerName` lógico
`wager-transactions`); `referenceExternalTransactionId` aceito como opcional
em `data` (o exemplo da §10 omite, §7 exige quando o kind referencia);
`LOSS`/`REFUND`/`ROLLBACK` → permanente (sem caso de uso **nesta etapa**;
desde a etapa final os três têm caso de uso e são despachados normalmente);
corrida na Inbox (violação da única) → ack. Detalhadas em `ARCHITECTURE.md`.

### Testes executados nesta etapa
- **Unitários (22 novos):** envelope (10), caso de uso (5), worker (7).
- **Integração PostgreSQL + LocalStack reais (6 novos):** reentrega sem
  duplicar efeitos; atomicidade (falha não deixa Inbox nem efeitos); queda
  entre commit e ack com recuperação por outra instância; erro transitório
  reentregue até a DLQ (`maxReceiveCount`); erro permanente à DLQ + ack; três
  consumidores concorrentes sem duplicar nem perder.

Limites respeitados: nada de LOSS/REFUND/ROLLBACK, API HTTP, observabilidade
ou dependências novas; migrations intactas; `docs/README-official.md`
inalterado; nenhum commit, `git reset`/`git clean`, reinstalação ou deploy.

---

## Etapa final — regras de reversão do §7 (F1/F2/F3 + A1/A2), testes entre processos e entrega

Esta etapa fecha a entrega e **também registra trabalho que não teve entrada
própria na cronologia** (a camada HTTP e os casos de uso de `LOSS`/`REFUND`/
`ROLLBACK`): os números de "Validações" já os incluíam, mas as decisões não
haviam sido registradas aqui.

### O que entrou
- **Camada HTTP (§9)** — `src/http/` com 7 rotas de negócio (`POST /wallets`,
  `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`,
  `POST /wallets/:walletId/reconciliation`, `POST /wagering/transactions`,
  `GET /wagering/transactions/:transactionId`,
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`)
  mais `/health/live` e `/health/ready`; um único mapeamento de status
  (400/404/409/422/202/503); controllers sem regra financeira, reutilizando
  os casos de uso (16 testes de integração).
- **Casos de uso `LOSS`, `REFUND` e `ROLLBACK`** — `ProcessLossUseCase` e
  `ProcessReversalUseCase`, com o julgamento centralizado em
  `evaluateReversal` (`process-support.ts`): regra 1 (referência obrigatória),
  regra 3 (alvo `PROCESSED` e elegível — `REFUND` só reverte `BET`),
  regra 5 (valor igual) e regra 4 ampliada (**no máximo uma** reversão
  processada por referência, seja qual for o tipo). O mesmo julgamento vale
  para a resolução tardia (worker de §7.1).
- **A1 — auditoria da corrida:** o perdedor da disputa do índice único vira
  linha `REJECTED` + `REFERENCE_ALREADY_REVERSED` em transação própria, com
  evento de rejeição; resposta **409** (primeira chamada e replay). Se a
  auditoria não puder ser gravada, o conflito continua reportado e a falha vai
  para o log — nunca se afirma persistência que não aconteceu.
- **A2 — garantia no banco:** `Migration20261025120000_ReversalUniqueProcessed`
  e `Migration20261025160000_ReversalUniquePerReference`
  (`(provider_id, reference_external_transaction_id)` para reversões
  `PROCESSED`), com `up`/`down` executados e conferidos no banco de integração.
- **Testes entre processos independentes** —
  `test/integration/multi-process.integration.e2e-spec.ts` +
  `test/integration/support/child-runner.ts`: três cenários, cada um com
  processos `bun` separados (conexões próprias, largada simultânea por
  `READY`/`GO`):
  1. §8: duas apostas de `80.00` sobre `100.00` em processos distintos →
     uma `PROCESSED`, uma `REJECTED`, saldo `20.00`, **um** débito;
  2. corrida `REFUND` × `ROLLBACK` sobre a mesma referência → uma `PROCESSED`
     e uma `REJECTED` + auditoria, saldo intacto;
  3. commit antes do ACK: o processo que consome sai **sem** ack, a mensagem
     volta por visibilidade e outro processo responde `duplicate` — saldo
     `75.00`, ledger e outbox íntegros, **um** registro na Inbox.

### Problemas reais encontrados e corrigidos (no harness de teste)
1. `process.execPath` dentro do Vitest é o **Node** do harness, não o Bun: as
   crianças passaram a ser lançadas com o `bun` resolvido via `where bun`;
   `DATABASE_URL` só por ambiente (nenhuma credencial em argv ou log).
2. A barreira por polling (`setInterval` dentro do executor da Promise) nunca
   disparava no worker do Vitest/Windows — substituída por leitura do `READY`
   no `stdout` (event-driven) com prazo externo via `Promise.race`.
3. As crianças não terminavam depois do `GO`: `process.stdin.resume()`
   mantinha o loop de eventos vivo — corrigido com `pause()`/`unref()` após a
   largada.
4. `receive(…, 0)` (visibilidade zero) expirava o `receipt handle` e o ACK
   falhava com `HTTP 400` do LocalStack — a reentrega passou a usar janela de
   30 s.

### Validações desta etapa
| Comando | Resultado |
|---|---|
| `bun run build` | exit 0 |
| `bun run lint` | exit 0, sem diagnósticos novos |
| `bunx tsc --noEmit` | exit 0, sem saída |
| `bun run test` | 258 testes, 22 arquivos — todos passando (exit 0) |
| `bun run test:integration` | 10 arquivos, 92 testes — passando (exit 0) |

### Limites respeitados nesta etapa
Migrations executadas **apenas** no banco de integração; nenhum teste
removido, ignorado nem com asserção enfraquecida; `docs/README-official.md`
inalterado; nenhum push, `git reset`, `git clean`, reinstalação ou deploy.

---

## Entrega de emergência — correções de auditoria (25/10/2026)
Escopo deliberadamente mínimo: defeitos confirmados de risco financeiro e o
requisito obrigatório pendente (§12), sem refatoração nem novos recursos.

1. **BUG-03 — perda de eventos confirmados da outbox (corrigido).** O claim
   (`OutboxMessageRepository.claimPublishable`) filtrava `attempts < 10`:
   esgotado o orçamento, a mensagem `PENDING` nunca mais era reivindicada e o
   evento confirmado no commit se perdia para sempre — violação direta de §3
   ("não perder eventos confirmados") e §11 ("sem perder nem duplicar
   indefinidamente"). Correção: remoção do teto de tentativas na seleção; o
   backoff (`5 s × 2^(n−1)`, teto 15 min) passa a limitar só a cadência. O
   teste unitário que fixava o comportamento com defeito ("só reivindica
   mensagens com tentativas sobrando") foi **substituído** pelo comportamento
   correto ("publica também a mensagem com tentativas já esgotadas"), e o
   cenário novo em PostgreSQL real cobre a recuperação
   (`outbox-publisher.integration`).
2. **BUG-02 — elegibilidade da WIN (sem mudança de comportamento).** Conferido
   no código e contra o README oficial: a regra 2 resolve a referência por
   chave + identidade (provider, player, wallet, moeda, rodada) e **não**
   impõe condição de status/kind ao alvo — a exigência de `BET` `PROCESSED`
   vale apenas para `REFUND`/`ROLLBACK` (tabela §7 + regra 3), e o efeito da
   `WIN` é crédito com referência **opcional**. O crédito em todos os cenários
   da auditoria (BET `REJECTED`, `LOSS`, `REFUND`, BET `PROCESSED`, alvo ainda
   `PENDING_REFERENCE`) é o comportamento deliberado e documentado
   (`ARCHITECTURE.md`, "Decisão — política de referência do `WIN`", item 3);
   restringir exigiria inventar regra sem respaldo no desafio. Adicionados 4
   testes de regressão que fixam a política e seus limites (identidade
   divergente continua `REFERENCE_MISMATCH`).
3. **BUG-04/05 — erros permanentes (corrigido).** `http-errors.ts`:
   `CURRENCY_MISMATCH`/`WALLET_PLAYER_MISMATCH` deixam de cair em 503
   (transitório) e passam a 400; violação de unique responde 409 com código
   estável (`UNIQUE_CONSTRAINT_VIOLATION`); o fallback 503 responde
   `INTERNAL_ERROR` — mensagens internas do banco não são mais expostas.
   `consumer-error.ts`: payload permanentemente inválido (`INVALID_*`,
   validações de domínio, divergências de identidade) vira permanente (DLQ
   imediata), eliminando retentativas inúteis. 23 testes novos.
4. **Observabilidade (README §12) — implementada no mínimo do contrato.**
   Logs estruturados em JSON (`logEvent` + `JsonLogger` registrado em
   `main.ts`) com `correlationId`, `messageId`, `transactionId`, `walletId` e
   `providerId`, sem payload financeiro; métricas em memória
   (`src/infrastructure/observability/metrics.ts`) expostas em `GET /metrics`,
   cobrindo transações por status, duplicatas, retries, DLQ, conflitos de
   lock, outbox lag e latência de processamento. Limitação honesta: registro
   por processo, sem agregação entre instâncias (ver `ARCHITECTURE.md`).

---

## Validações
Resultados da última execução completa, feita na entrega de emergência
(após as correções de auditoria e a observabilidade):

| Comando | Resultado |
|---|---|
| `bun run test` | 289 testes, 25 arquivos — todos passando (exit 0) |
| `bun run lint` | exit 0, 2 warnings pré-existentes (`require-array-sort-compare` em `outbox-publisher.integration`), nenhum novo |
| `bunx tsc --noEmit` | exit 0, sem saída |
| `bun run build` | exit 0 |
| `bun run test:integration` | 10 arquivos, 93 testes — passando (exit 0) |

Baselines: antes da entrega final, 248 unitários e 81 de integração (9
arquivos); antes da Fase 13, `bun run test` com 143 testes em 9 arquivos e
`bun run test:integration` com 30 testes em 4 arquivos; antes da Fase 12,
131 testes em 8 arquivos e 20 testes em 3 arquivos; antes da Fase 10,
124 testes em 8 arquivos e 19 testes em 3 arquivos; antes da Fase 9,
72 testes em 7 arquivos (todos passando). As correções da auditoria da
Fase 13 somaram 4 unitários e 2 de integração, sem novos arquivos de teste;
o incremento da outbox somou 21 unitários (2 arquivos novos) e 6 de
integração (1 arquivo novo); a separação da fila de eventos somou 6
unitários (1 arquivo novo) e 1 de integração; a etapa do consumidor somou 22
unitários (3 arquivos novos) e 6 de integração (1 arquivo novo); a etapa
final somou 10 unitários (2 arquivos novos: `process-support.spec.ts` e
`process-reversal.use-case.spec.ts`), elevou as reversões de 12 para 20
testes de integração e acrescentou 3 testes entre processos (1 arquivo novo
mais o runner infantil).

Distribuição atual: 258 unitários (money, wallet, wallet-ledger-entry,
wager-transaction, payload-hash, open-wallet, process-bet, process-win,
**reference-retry-policy**, **resolve-pending-references**,
**pending-reference.worker**, **publish-outbox-messages**,
**outbox-publisher.worker**, **sqs-outbox-publisher**,
**wager-transaction-requested**, **receive-wager-transaction**,
**wager-command-consumer.worker**, **inbox-message**,
**inbox-message.repository**, **process-support**, **process-reversal**,
app.controller) + 92 de integração (8 PostgreSQL + 8 concorrência + 10 WIN +
**10 referência pendente** + **7 outbox** + **6 consumo de comandos** + 4 SQS
+ **16 HTTP** + **20 reversões** + **3 entre processos**).

## Limitações que permanecem
1. **≥3 processos/instâncias simultâneos e reinício do serviço não
   testados** — a concorrência entre **2 processos independentes** está
   comprovada (etapa final), assim como a entre transações/conexões de um
   processo (Fase 8) e entre instâncias dos workers; faltam ≥3 processos ao
   mesmo tempo e o teste de reinício.
2. **Observabilidade (§12)** — implementada no mínimo do contrato na entrega
   de emergência (logs JSON estruturados e métricas em `GET /metrics`);
   persiste a limitação de o registro ser **por processo**, sem agregação
   entre instâncias (exporter/OTel é opcional no §12).
3. **Consumidor da fila de eventos** da outbox (§11, passo 5) não
   implementado — quem torna a duplicata de publicação segura do lado dos
   eventos.
4. **`WalletRepository.create`** cria wallet sem os registros financeiros
   obrigatórios e fora de transação — caminho inseguro pendente de decisão.
5. **Reversão (`down`) da migration inicial nunca executada** — a `down` das
   outras três já foi executada e conferida no banco de integração.
6. **`bun run test:e2e`** falha por problema conhecido de configuração do
   scaffold NestJS (enums em strip-only mode do Node 24).
7. **SIGTERM não é testado** — o desligamento gracioso está implementado
   (shutdown hooks + ciclo em andamento aguardado), mas não há teste do sinal.

## Próximos passos
Em ordem de dependência (detalhamento em `PLAN.md`):

1. **Decidir o destino de `WalletRepository.create`** (remover ou tornar
   transacional).
2. **Testes com ≥3 processos/instâncias simultâneos** e com **reinício do
   serviço** — encerra a frente de concorrência e idempotência.
3. ~~**Observabilidade (§12)** — logs JSON com IDs de correlação e métricas.~~
   Concluída no mínimo do contrato (entrega de emergência).
4. **Consumidor da fila de eventos** da outbox (§11, passo 5).
5. **Corrigir `bun run test:e2e`** (configuração do scaffold NestJS).
