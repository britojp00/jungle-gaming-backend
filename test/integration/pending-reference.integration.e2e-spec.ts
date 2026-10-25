import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/application/wallets/use-cases/open-wallet.use-case.js';
import {
  REFERENCE_RETRY_MAX_ATTEMPTS,
  REFERENCE_TTL_MS,
} from '../../src/application/wagering/reference-retry-policy.js';
import {
  ProcessBetInput,
  ProcessBetUseCase,
} from '../../src/application/wagering/use-cases/process-bet.use-case.js';
import {
  ResolvePendingReferencesUseCase,
  ResolvePendingReferencesResult,
} from '../../src/application/wagering/use-cases/resolve-pending-references.use-case.js';
import {
  ProcessWinInput,
  ProcessWinResult,
  ProcessWinUseCase,
} from '../../src/application/wagering/use-cases/process-win.use-case.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { LedgerDirection } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../src/infrastructure/persistence/entities/outbox-message.entity.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/infrastructure/persistence/entities/wager-transaction.entity.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';

/**
 * Testes do worker de §7.1 (`ResolvePendingReferencesUseCase`) contra o
 * PostgreSQL REAL: referência que chega depois, backoff e janela de
 * elegibilidade, limite de tentativas, TTL, duas instâncias concorrentes,
 * falha antes e depois do commit e replay do resultado terminal.
 *
 * O relógio é SEMPRE injetado (`execute({ now })`): nenhuma asserção
 * depende do tempo de parede, e cada "instância" recebe o seu próprio
 * EntityManager (`orm.em.fork()`).
 *
 * Invariante final de todos os cenários (README §13):
 *   wallet.balance == saldo reconstruído pelo ledger
 */

let orm: MikroORM;

/**
 * Cada teste captura o seu próprio `t0 = new Date()` DEPOIS de criar as
 * linhas pendentes: a elegibilidade compara a janela gravada no INSERT
 * (`now()` do banco) com o relógio injetado, então `t0` precisa ser igual ou
 * posterior à criação da linha. Todos os deslocamentos seguintes são
 * relativos a `t0` — nenhuma asserção depende do relógio de parede.
 */

beforeAll(async () => {
  orm = await bootstrapIntegrationOrm();
}, 60_000);

afterAll(async () => {
  await disposeIntegrationOrm();
});

beforeEach(async () => {
  await truncateIntegrationTables();
});

function connection() {
  return orm.em.getConnection();
}

/** Uma "instância" do worker: EM próprio, como um processo separado. */
function instanceEm(): EntityManager {
  return orm.em.fork();
}

function tick(
  now: Date,
  options: { limit?: number } = {},
): Promise<ResolvePendingReferencesResult> {
  return new ResolvePendingReferencesUseCase(instanceEm()).execute({
    now,
    ...options,
  });
}

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

/**
 * `timestamptz` lido por SQL cru volta como a string literal do Postgres
 * (`2026-10-25 02:12:18.68+00`), não como `Date` — mesmo formato que o
 * repositório normaliza em `toReferenceDate`.
 */
function dateOf(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  return new Date(
    String(value)
      .replace(' ', 'T')
      .replace(/([+-]\d{2})$/, '$1:00'),
  );
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
}

interface LedgerRow {
  direction: LedgerDirection;
  amount: string;
  balance_before: string;
  balance_after: string;
  currency: string;
  transaction_id: string;
}

interface TransactionRow {
  id: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  round_id: string | null;
  rejection_reason: string | null;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  result_balance_amount: string | null;
  result_wallet_version: number | null;
  reference_attempts: number;
  reference_next_attempt_at: Date;
  processed_at: Date | null;
}

interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, any>;
}

async function readWalletRow(walletId: string): Promise<WalletRow> {
  const rows = (await connection().execute(
    `select id, player_id, currency, balance, version from wallets where id = '${walletId}'`,
  )) as WalletRow[];

  expect(rows).toHaveLength(1);

  return rows[0]!;
}

async function readLedgerRows(walletId: string): Promise<LedgerRow[]> {
  return (await connection().execute(
    `select direction, amount, balance_before, balance_after, currency, transaction_id
       from wallet_ledger_entries where wallet_id = '${walletId}'
      order by created_at`,
  )) as LedgerRow[];
}

async function readTransactionRows(
  walletId: string,
): Promise<TransactionRow[]> {
  return (await connection().execute(
    `select id, kind, status, amount, currency, round_id, rejection_reason,
            reference_external_transaction_id, reference_transaction_id,
            result_balance_amount, result_wallet_version,
            reference_attempts, reference_next_attempt_at, processed_at
       from wager_transactions where wallet_id = '${walletId}'`,
  )) as TransactionRow[];
}

async function findWin(walletId: string): Promise<TransactionRow> {
  const wins = (await readTransactionRows(walletId)).filter(
    (row) => row.kind === WagerTransactionKind.WIN,
  );

  expect(wins).toHaveLength(1);

  return wins[0]!;
}

async function readOutboxRows(): Promise<OutboxRow[]> {
  return (await connection().execute(
    `select event_type, aggregate_id, payload from outbox_messages`,
  )) as OutboxRow[];
}

function countByEventType(rows: OutboxRow[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
  }

  return counts;
}

async function openWallet(
  playerId: string,
  initialAmount: string,
): Promise<{ id: string; version: number }> {
  return new OpenWalletUseCase(instanceEm()).execute({
    playerId,
    initialBalance: Money.from({ amount: initialAmount, currency: 'BRL' }),
  });
}

function winInput(
  walletId: string,
  playerId: string,
  overrides: Partial<ProcessWinInput> = {},
): ProcessWinInput {
  const id = randomUUID();

  return {
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: `win-${id}`,
    idempotencyKey: `key-win-${id}`,
    amount: '25.00',
    currency: 'BRL',
    roundId: overrides.roundId ?? 'round-shared',
    gameId: 'fortune-chimp',
    ...overrides,
  };
}

function betInput(
  walletId: string,
  playerId: string,
  overrides: Partial<ProcessBetInput> = {},
): ProcessBetInput {
  const id = randomUUID();

  return {
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: 'bet-777',
    idempotencyKey: `key-bet-${id}`,
    amount: '10.00',
    currency: 'BRL',
    roundId: overrides.roundId ?? 'round-shared',
    gameId: 'fortune-chimp',
    ...overrides,
  };
}

function processWin(input: ProcessWinInput): Promise<ProcessWinResult> {
  return new ProcessWinUseCase(instanceEm()).execute(input);
}

function processBet(input: ProcessBetInput) {
  return new ProcessBetUseCase(instanceEm()).execute(input);
}

/**
 * Reescreve por SQL o estado de agendamento de uma linha — é assim que os
 * testes envelhecem uma pendência sem esperar horas de relógio real.
 */
async function scheduleRow(
  transactionId: string,
  state: {
    createdAt?: Date;
    referenceNextAttemptAt?: Date;
    referenceAttempts?: number;
  },
): Promise<void> {
  const assignments = [
    state.createdAt
      ? `created_at = '${state.createdAt.toISOString()}'`
      : null,
    state.referenceNextAttemptAt
      ? `reference_next_attempt_at = '${state.referenceNextAttemptAt.toISOString()}'`
      : null,
    state.referenceAttempts !== undefined
      ? `reference_attempts = ${state.referenceAttempts}`
      : null,
  ].filter((fragment): fragment is string => fragment !== null);

  await connection().execute(
    `update wager_transactions set ${assignments.join(', ')} where id = '${transactionId}'`,
  );
}

/**
 * EM cujo `flush` falha DEPOIS de ter escrito as linhas na transação e ANTES
 * do commit — mas apenas quando uma `OutboxMessageEntity` já foi persistida
 * (o flush final da linha). É o ponto em que a atomicidade precisa valer.
 */
function emWithForcedPostFlushFailure(): EntityManager {
  const real = instanceEm();

  const failingTx = (
    txEm: EntityManager,
    state: { outboxPersisted: boolean },
  ): EntityManager =>
    new Proxy(txEm, {
      get(target, property) {
        if (property === 'persist') {
          return (entity: Parameters<EntityManager['persist']>[0]) => {
            if (entity instanceof OutboxMessageEntity) {
              state.outboxPersisted = true;
            }

            return target.persist(entity);
          };
        }

        if (property === 'flush') {
          return async (): Promise<void> => {
            await target.flush();

            if (state.outboxPersisted) {
              throw new Error('FORCED_FAILURE_AFTER_OUTBOX_FLUSH');
            }
          };
        }

        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(real, {
    get(target, property) {
      if (property === 'transactional') {
        return <T,>(cb: (em: EntityManager) => Promise<T>): Promise<T> => {
          const state = { outboxPersisted: false };

          return target.transactional((txEm) => cb(failingTx(txEm, state)));
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * EM que falha DEPOIS de a transação financeira ter confirmado — o processo
 * "morre" logo após o commit, sem conseguir reportar o resultado. O estado
 * persistido tem que estar completo, e o ciclo seguinte não pode reaplicar.
 */
function emWithForcedFailureAfterCommit(): EntityManager {
  const real = instanceEm();

  const trackingTx = (
    txEm: EntityManager,
    state: { outboxPersisted: boolean },
  ): EntityManager =>
    new Proxy(txEm, {
      get(target, property) {
        if (property === 'persist') {
          return (entity: Parameters<EntityManager['persist']>[0]) => {
            if (entity instanceof OutboxMessageEntity) {
              state.outboxPersisted = true;
            }

            return target.persist(entity);
          };
        }

        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(real, {
    get(target, property) {
      if (property === 'transactional') {
        return <T,>(cb: (em: EntityManager) => Promise<T>): Promise<T> => {
          const state = { outboxPersisted: false };

          return target
            .transactional((txEm) => cb(trackingTx(txEm, state)))
            .then((value) => {
              if (state.outboxPersisted) {
                throw new Error('FORCED_FAILURE_AFTER_COMMIT');
              }

              return value;
            });
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Consistência final persistida de uma wallet, lida exclusivamente por SQL
 * cru (README §13): saldo não negativo, cadeia do ledger, saldo materializado
 * == saldo reconstruído, soma independente, transações sem efeito sem
 * lançamento e `version == 1 + movimentações que não sejam da abertura`.
 */
async function assertWalletLedgerConsistency(walletId: string): Promise<void> {
  const wallet = await readWalletRow(walletId);
  const stored = Money.from({
    amount: wallet.balance,
    currency: wallet.currency,
  });

  expect(stored.isNegative()).toBe(false);

  const entries = await readLedgerRows(walletId);
  const transactions = await readTransactionRows(walletId);

  for (const entry of entries) {
    expect(entry.currency).toBe(wallet.currency);
  }

  const pending = [...entries];
  let reconstructed = Money.zero(wallet.currency);

  while (pending.length > 0) {
    const index = pending.findIndex(
      (entry) => entry.balance_before === reconstructed.toJSON().amount,
    );

    expect(
      index,
      `cadeia do ledger quebrada: nenhum lançamento parte de ` +
        `${reconstructed.toJSON().amount}`,
    ).toBeGreaterThanOrEqual(0);

    const entry = pending.splice(index, 1)[0]!;
    const before = Money.from({
      amount: entry.balance_before,
      currency: entry.currency,
    });
    const after = Money.from({
      amount: entry.balance_after,
      currency: entry.currency,
    });
    const amount = Money.from({
      amount: entry.amount,
      currency: entry.currency,
    });
    const expected =
      entry.direction === LedgerDirection.CREDIT
        ? before.add(amount)
        : before.subtract(amount);

    expect(after.equals(expected)).toBe(true);
    reconstructed = after;
  }

  expect(reconstructed.equals(stored)).toBe(true);

  let totalCredit = Money.zero(wallet.currency);
  let totalDebit = Money.zero(wallet.currency);

  for (const entry of entries) {
    const amount = Money.from({
      amount: entry.amount,
      currency: entry.currency,
    });

    if (entry.direction === LedgerDirection.CREDIT) {
      totalCredit = totalCredit.add(amount);
    } else {
      totalDebit = totalDebit.add(amount);
    }
  }

  expect(totalCredit.subtract(totalDebit).equals(stored)).toBe(true);

  // Nenhuma transação com dois lançamentos: a unique (wallet_id,
  // transaction_id) é a última linha de defesa contra crédito duplicado.
  const entryTransactionIds = entries.map((entry) => entry.transaction_id);
  expect(new Set(entryTransactionIds).size).toBe(entryTransactionIds.length);

  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const entryTransactionIdSet = new Set(entryTransactionIds);

  for (const transaction of transactions) {
    const hasEntry = entryTransactionIdSet.has(transaction.id);
    const generatesLedger =
      transaction.kind === WagerTransactionKind.OPENING ||
      transaction.kind === WagerTransactionKind.BET ||
      transaction.kind === WagerTransactionKind.WIN;

    if (
      generatesLedger &&
      transaction.status === WagerTransactionStatus.PROCESSED
    ) {
      expect(hasEntry).toBe(true);
    }

    if (
      transaction.status === WagerTransactionStatus.REJECTED ||
      transaction.status === WagerTransactionStatus.FAILED ||
      transaction.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      expect(hasEntry).toBe(false);
    }
  }

  for (const entry of entries) {
    expect(transactionById.get(entry.transaction_id)?.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
  }

  const nonOpeningEntries = entries.filter(
    (entry) =>
      transactionById.get(entry.transaction_id)?.kind !==
      WagerTransactionKind.OPENING,
  );
  expect(wallet.version).toBe(1 + nonOpeningEntries.length);
}

describe('Worker §7.1 — referência que chega depois', () => {
  it('resolve, credita, grava a FK e devolve o resultado terminal no replay', async () => {
    const playerId = `it-ref-late-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // A WIN chega ANTES da BET: é o caso que a §7.1 existe para cobrir.
    const input = winInput(wallet.id, playerId, {
      referenceExternalTransactionId: 'bet-777',
    });
    const first = await processWin(input);
    expect(first.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    const t0 = new Date();

    // 1º ciclo: nada a fazer, mas a tentativa já é contada e a janela gravada.
    const cycle1 = await tick(t0);
    expect(cycle1).toMatchObject({ claimed: 1, stillPending: 1, rejected: 0 });

    let row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(row.reference_attempts).toBe(1);
    expect(dateOf(row.reference_next_attempt_at)).toEqual(at(t0, 5_000));
    expect(row.reference_transaction_id).toBeNull();

    // A referência chega.
    await processBet(betInput(wallet.id, playerId));

    // 2º ciclo, dentro da janela: nem é selecionada.
    const inside = await tick(at(t0, 2_000));
    expect(inside.claimed).toBe(0);

    // 3º ciclo, aberta a janela: resolve e credita.
    const cycle2 = await tick(at(t0, 5_000));
    expect(cycle2).toMatchObject({ claimed: 1, resolved: 1, problems: [] });

    row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(row.reference_transaction_id).not.toBeNull();
    expect(row.processed_at).not.toBeNull();
    expect(row.reference_attempts).toBe(2);

    // §7, regra 7: saldo observado AO CONCLUIR (100 - 10 da BET + 25).
    expect(row.result_balance_amount).toBe('115.00');
    expect(row.result_wallet_version).toBe(3);

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('115.00');
    expect(walletRow.version).toBe(3);

    const entries = await readLedgerRows(wallet.id);
    expect(entries).toHaveLength(3); // abertura + BET + WIN

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 3,
      WagerTransactionProcessed: 2,
      WagerTransactionPendingReference: 1,
    });

    // Replay do resultado TERMINAL: devolve o que a transação observou,
    // sem novo efeito.
    const replay = await processWin(input);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(replay.balance).toEqual({ amount: '115.00', currency: 'BRL' });
    expect(replay.walletVersion).toBe(3);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 3,
      WagerTransactionProcessed: 2,
      WagerTransactionPendingReference: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);
});

describe('Worker §7.1 — backoff exponencial e janela de elegibilidade', () => {
  it('não reprocessa dentro da janela e dobra a espera a cada tentativa', async () => {
    const playerId = `it-ref-backoff-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-never',
      }),
    );

    // Tentativa 1 → espera de 5 s.
    const t0 = new Date();
    let now = t0;
    let result = await tick(now);
    expect(result).toMatchObject({ claimed: 1, stillPending: 1 });

    let row = await findWin(wallet.id);
    expect(row.reference_attempts).toBe(1);
    expect(dateOf(row.reference_next_attempt_at)).toEqual(at(now, 5_000));

    // Dentro da janela: sequer é selecionada (0 linhas lidas do banco).
    result = await tick(at(now, 4_999));
    expect(result.claimed).toBe(0);
    expect(result.stillPending).toBe(0);

    // Aberta a janela: tentativa 2 → espera de 10 s.
    now = at(now, 5_000);
    result = await tick(now);
    expect(result.claimed).toBe(1);
    row = await findWin(wallet.id);
    expect(row.reference_attempts).toBe(2);
    expect(dateOf(row.reference_next_attempt_at)).toEqual(at(now, 10_000));

    // Tentativa 3 → espera de 20 s.
    now = at(now, 10_000);
    result = await tick(now);
    expect(result.claimed).toBe(1);
    row = await findWin(wallet.id);
    expect(row.reference_attempts).toBe(3);
    expect(dateOf(row.reference_next_attempt_at)).toEqual(at(now, 20_000));

    // Nenhuma tentativa alterou saldo, ledger ou status.
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(await readLedgerRows(wallet.id)).toHaveLength(1); // só a abertura
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);
});

describe('Worker §7.1 — limite de tentativas e TTL', () => {
  it('esgota as 10 tentativas e rejeita com REFERENCE_NOT_FOUND', async () => {
    const playerId = `it-ref-limit-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const input = winInput(wallet.id, playerId, {
      referenceExternalTransactionId: 'bet-never',
    });
    await processWin(input);

    const t0 = new Date();

    // 30 min entre ciclos: maiores que o teto de backoff (15 min), então
    // todo ciclo encontra a janela aberta — e 9 × 30 min seguem dentro do
    // TTL de 6 h, provando que quem rejeita aqui é o CONTADOR de tentativas.
    let now = t0;
    const delays = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000, 900_000];

    for (let attempt = 1; attempt <= REFERENCE_RETRY_MAX_ATTEMPTS; attempt++) {
      const result = await tick(now);

      expect(result.claimed, `tentativa ${attempt}`).toBe(1);
      expect(result.rejected, `tentativa ${attempt}`).toBe(
        attempt === REFERENCE_RETRY_MAX_ATTEMPTS ? 1 : 0,
      );
      expect(result.stillPending, `tentativa ${attempt}`).toBe(
        attempt === REFERENCE_RETRY_MAX_ATTEMPTS ? 0 : 1,
      );

      const row = await findWin(wallet.id);
      expect(row.reference_attempts).toBe(attempt);
      expect(dateOf(row.reference_next_attempt_at)).toEqual(
        at(now, delays[attempt - 1]!),
      );

      now = at(now, 30 * 60_000);
    }

    // A 10ª rejeita: REJECTED + REFERENCE_NOT_FOUND + evento, atomicamente.
    const row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejection_reason).toBe('REFERENCE_NOT_FOUND');
    expect(row.processed_at).toBeNull();
    expect(row.result_balance_amount).toBe('100.00'); // sem efeito financeiro

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('100.00');
    expect(walletRow.version).toBe(1);
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
      WagerTransactionRejected: 1,
    });

    const rejected = (await readOutboxRows()).find(
      (row2) => row2.event_type === 'WagerTransactionRejected',
    );
    expect(rejected?.payload.data).toMatchObject({
      transactionId: row.id,
      status: WagerTransactionStatus.REJECTED,
      failureCode: 'REFERENCE_NOT_FOUND',
    });

    // Replay do resultado TERMINAL devolve a rejeição, sem novo evento.
    const replay = await processWin(input);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.REJECTED);
    expect(replay.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    await assertWalletLedgerConsistency(wallet.id);
  }, 60_000);

  it('rejeita por TTL com tentativas ainda sobrando, sem esperar a janela', async () => {
    const playerId = `it-ref-ttl-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const { transactionId } = await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-never',
      }),
    );

    const t0 = new Date();

    // Linha envelhecida além do TTL, com a janela exatamente no prazo (o
    // pior caso que a fórmula do claim produz) e só 1 tentativa consumida.
    const createdAt = at(t0, -(REFERENCE_TTL_MS + 60_000));
    await scheduleRow(transactionId, {
      createdAt,
      referenceNextAttemptAt: at(createdAt, REFERENCE_TTL_MS),
      referenceAttempts: 1,
    });

    const result = await tick(t0);
    expect(result).toMatchObject({ claimed: 1, rejected: 1 });
    expect(result.problems).toEqual([]);

    const row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejection_reason).toBe('REFERENCE_NOT_FOUND');
    expect(row.reference_attempts).toBe(2);

    // A janela nunca ultrapassa o prazo: fica agendada no vencimento, no
    // passado — por isso a linha foi elegível mesmo com backoff sobrando.
    expect(dateOf(row.reference_next_attempt_at).getTime()).toBe(
      at(createdAt, REFERENCE_TTL_MS).getTime(),
    );
    expect(dateOf(row.reference_next_attempt_at).getTime()).toBeLessThan(
      t0.getTime(),
    );

    expect(await readLedgerRows(wallet.id)).toHaveLength(1);
    expect((await readWalletRow(wallet.id)).balance).toBe('100.00');
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
      WagerTransactionRejected: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);
});

describe('Worker §7.1 — múltiplas instâncias', () => {
  it('duas instâncias concorrentes na mesma linha produzem um único crédito', async () => {
    const playerId = `it-ref-race-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-777',
      }),
    );
    await processBet(betInput(wallet.id, playerId));

    const t0 = new Date();

    const results = await Promise.all([tick(t0), tick(t0)]);

    // `SKIP LOCKED` + a janela gravada no claim: só uma instância leva a
    // linha; a outra volta com lote vazio.
    expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.resolved, 0)).toBe(1);

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('115.00'); // 100 - 10 + 25
    expect(walletRow.version).toBe(3);

    const entries = await readLedgerRows(wallet.id);
    expect(entries).toHaveLength(3);
    expect(entries.filter((entry) => entry.amount === '25.00')).toHaveLength(1);

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 3,
      WagerTransactionProcessed: 2,
      WagerTransactionPendingReference: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);

  it('duas instâncias drenando o lote processam cada linha exatamente uma vez', async () => {
    const playerId = `it-ref-batch-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // Quatro WINs pendentes, todas pela mesma BET que ainda não existe.
    const inputs = Array.from({ length: 4 }, () =>
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-777',
      }),
    );

    for (const input of inputs) {
      const result = await processWin(input);
      expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    }

    await processBet(betInput(wallet.id, playerId));

    const t0 = new Date();

    const results = await Promise.all([
      tick(t0, { limit: 4 }),
      tick(t0, { limit: 4 }),
    ]);

    expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(4);
    expect(results.reduce((sum, r) => sum + r.resolved, 0)).toBe(4);
    expect(results.flatMap((r) => r.problems)).toEqual([]);

    // 100 - 10 (BET) + 4 × 25 (WINs), sem duplicar nada.
    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('190.00');
    expect(walletRow.version).toBe(6);

    const entries = await readLedgerRows(wallet.id);
    expect(entries).toHaveLength(6); // abertura + BET + 4 WINs
    expect(entries.filter((entry) => entry.amount === '25.00')).toHaveLength(4);

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 6,
      WagerTransactionProcessed: 5, // BET + 4 WINs
      WagerTransactionPendingReference: 4,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);
});

describe('Worker §7.1 — falha, crash e recuperação', () => {
  it('falha antes do commit desfaz tudo, mantém a pendência e não cicla em seguida', async () => {
    const playerId = `it-ref-crash-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-777',
      }),
    );
    await processBet(betInput(wallet.id, playerId));

    const t0 = new Date();

    const result = await new ResolvePendingReferencesUseCase(
      emWithForcedPostFlushFailure(),
    ).execute({ now: t0 });

    expect(result).toMatchObject({
      claimed: 1,
      resolved: 0,
      stillPending: 0,
      rejected: 0,
    });
    expect(result.problems).toEqual([
      expect.objectContaining({
        reason: 'PROCESSING_FAILED',
        detail: 'FORCED_FAILURE_AFTER_OUTBOX_FLUSH',
      }),
    ]);

    // Rollback real: nenhuma linha da transação financeira sobreviveu.
    const row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(row.reference_transaction_id).toBeNull();
    expect(row.result_balance_amount).toBe('100.00');
    expect(await readLedgerRows(wallet.id)).toHaveLength(2); // abertura + BET
    expect((await readWalletRow(wallet.id)).balance).toBe('90.00');
    expect((await readWalletRow(wallet.id)).version).toBe(2);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2, // abertura + WIN da BET
      WagerTransactionProcessed: 1,
      WagerTransactionPendingReference: 1,
    });

    // O claim sobrevive ao crash: tentativa contada e janela futura
    // gravadas — a pendência não se perde e não há ciclo imediato.
    expect(row.reference_attempts).toBe(1);
    expect(dateOf(row.reference_next_attempt_at)).toEqual(at(t0, 5_000));

    const inside = await tick(at(t0, 1_000));
    expect(inside.claimed).toBe(0);

    // Recuperação: com a janela aberta, o mesmo ciclo conclui.
    const recovered = await tick(at(t0, 5_000));
    expect(recovered).toMatchObject({ claimed: 1, resolved: 1, problems: [] });

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('115.00');
    expect(walletRow.version).toBe(3);
    expect((await findWin(wallet.id)).status).toBe(
      WagerTransactionStatus.PROCESSED,
    );

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);

  it('crash depois do commit deixa o estado completo e o próximo ciclo não reaplica', async () => {
    const playerId = `it-ref-after-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-777',
      }),
    );
    await processBet(betInput(wallet.id, playerId));

    const t0 = new Date();

    const result = await new ResolvePendingReferencesUseCase(
      emWithForcedFailureAfterCommit(),
    ).execute({ now: t0 });

    // O processo morreu depois do commit: a linha já está concluída.
    expect(result.problems).toEqual([
      expect.objectContaining({ detail: 'FORCED_FAILURE_AFTER_COMMIT' }),
    ]);

    const row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(row.reference_transaction_id).not.toBeNull();
    expect(row.result_balance_amount).toBe('115.00');

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('115.00');
    expect(walletRow.version).toBe(3);
    expect(await readLedgerRows(wallet.id)).toHaveLength(3);

    const eventsBefore = countByEventType(await readOutboxRows());
    expect(eventsBefore).toEqual({
      WalletBalanceChanged: 3,
      WagerTransactionProcessed: 2,
      WagerTransactionPendingReference: 1,
    });

    // Entrega repetida: o ciclo seguinte nem seleciona a linha, porque ela
    // já saiu do conjunto `PENDING_REFERENCE` — nada é aplicado duas vezes.
    const next = await tick(at(t0, 30 * 60_000));
    expect(next.claimed).toBe(0);
    expect(countByEventType(await readOutboxRows())).toEqual(eventsBefore);
    expect((await readWalletRow(wallet.id)).balance).toBe('115.00');

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);
});

describe('Worker §7.1 — referência irrecuperável', () => {
  it('não credita a WIN cuja referência aponta para ela mesma e a termina pela §7.1', async () => {
    const playerId = `it-self-ref-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // `externalTransactionId === referenceExternalTransactionId`: não há
    // outra transação que resolva a referência — e como (provider_id,
    // external_transaction_id) é único, nunca haverá.
    const selfReference = `win-self-${randomUUID()}`;
    const input = winInput(wallet.id, playerId, {
      externalTransactionId: selfReference,
      referenceExternalTransactionId: selfReference,
    });
    const { transactionId } = await processWin(input);

    const t0 = new Date();

    // 1º ciclo: segue pendente, sem crédito para a própria linha.
    const cycle1 = await tick(t0);
    expect(cycle1).toMatchObject({
      claimed: 1,
      stillPending: 1,
      resolved: 0,
      rejected: 0,
    });

    let row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(row.reference_transaction_id).toBeNull();
    expect(row.reference_attempts).toBe(1);

    // Nada de saldo, ledger nem evento novo além do aceite (§7, regra 6 e §11).
    expect((await readWalletRow(wallet.id)).balance).toBe('100.00');
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
    });

    // Orçamento esgotado: §7.1 termina com a referência inexistente.
    await scheduleRow(transactionId, {
      referenceAttempts: REFERENCE_RETRY_MAX_ATTEMPTS,
      referenceNextAttemptAt: t0,
    });

    const cycle2 = await tick(at(t0, 1));
    expect(cycle2).toMatchObject({
      claimed: 1,
      rejected: 1,
      resolved: 0,
      problems: [],
    });

    row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejection_reason).toBe('REFERENCE_NOT_FOUND');
    expect(row.reference_transaction_id).toBeNull();
    expect(row.result_balance_amount).toBe('100.00');

    expect((await readWalletRow(wallet.id)).balance).toBe('100.00');
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
      WagerTransactionRejected: 1,
    });

    // Replay devolve a rejeição terminal, sem novo evento.
    const replay = await processWin(input);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.REJECTED);
    expect(replay.failureCode).toBe('REFERENCE_NOT_FOUND');

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);

  it('termina a linha com vínculo wallet ↔ transação corrompido, sem retry infinito', async () => {
    const playerId = `it-broken-link-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const { transactionId } = await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-never',
      }),
    );

    // Só dados já corrompidos no banco produzem esse caso: a entrada valida
    // player e moeda antes de gravar. `wallets.player_id` não muda depois da
    // abertura, então a linha jamais se corrige esperando.
    await connection().execute(
      `update wager_transactions set player_id = 'someone-else' where id = '${transactionId}'`,
    );

    const t0 = new Date();
    const result = await tick(t0);

    expect(result).toMatchObject({
      claimed: 1,
      inconsistent: 1,
      resolved: 0,
      rejected: 0,
    });
    expect(result.problems).toEqual([
      {
        reason: 'UNRESOLVABLE_STATE',
        transactionId,
        walletId: wallet.id,
        missing: 'player_id',
      },
    ]);

    const row = await findWin(wallet.id);
    expect(row.status).toBe(WagerTransactionStatus.FAILED);
    expect(row.rejection_reason).toBe('INTERNAL_ERROR');
    expect(row.reference_transaction_id).toBeNull();
    expect(row.result_balance_amount).toBe('100.00');

    // Sem efeito financeiro e sem evento (§11 não prevê evento para falha
    // de infraestrutura): só o estado terminal auditável mudou.
    expect((await readWalletRow(wallet.id)).balance).toBe('100.00');
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
    });

    // Terminal (§6.3): o ciclo seguinte não reivindica mais a linha.
    const after = await tick(at(t0, 30 * 60_000));
    expect(after.claimed).toBe(0);

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);
});
