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
  ProcessBetInput,
  ProcessBetUseCase,
} from '../../src/application/wagering/use-cases/process-bet.use-case.js';
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
 * Testes do `ProcessWinUseCase` contra o PostgreSQL REAL do ambiente
 * isolado: crédito imediato, referência inexistente (`PENDING_REFERENCE`),
 * referência resolvida, divergência de vínculo, replay, corrida de duas
 * requisições idênticas, rollback real e consistência final.
 *
 * Cada "requisição" recebe o seu próprio EntityManager (`orm.em.fork()`),
 * como em um processo HTTP real. Todo o estado asserted vem de SQL cru (fora
 * do identity map) e toda a aritmética monetária usa `Money` com strings
 * decimais — nunca `number`.
 *
 * Invariante final de todos os cenários (README §13):
 *   wallet.balance == saldo reconstruído pelo ledger
 */

let orm: MikroORM;

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

/** Um EntityManager isolado por requisição — o análogo de um pedido HTTP. */
function requestEm(): EntityManager {
  return orm.em.fork();
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
  provider_id: string | null;
  external_transaction_id: string | null;
  idempotency_key: string | null;
  payload_hash: string | null;
  round_id: string | null;
  rejection_reason: string | null;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  result_balance_amount: string | null;
  processed_at: Date | null;
}

interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  status: string;
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

async function readTransactionRows(walletId: string): Promise<TransactionRow[]> {
  return (await connection().execute(
    `select id, kind, status, amount, currency, provider_id, external_transaction_id,
            idempotency_key, payload_hash, round_id, rejection_reason,
            reference_external_transaction_id, reference_transaction_id,
            result_balance_amount, processed_at
     from wager_transactions where wallet_id = '${walletId}'`,
  )) as TransactionRow[];
}

async function readOutboxRows(): Promise<OutboxRow[]> {
  return (await connection().execute(
    `select event_type, aggregate_id, status, payload from outbox_messages`,
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
  return new OpenWalletUseCase(requestEm()).execute({
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
    roundId: `round-${id}`,
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
    externalTransactionId: `bet-${id}`,
    idempotencyKey: `key-bet-${id}`,
    amount: '10.00',
    currency: 'BRL',
    roundId: `round-${id}`,
    gameId: 'fortune-chimp',
    ...overrides,
  };
}

function processWin(input: ProcessWinInput): Promise<ProcessWinResult> {
  return new ProcessWinUseCase(requestEm()).execute(input);
}

function processBet(input: ProcessBetInput) {
  return new ProcessBetUseCase(requestEm()).execute(input);
}

/**
 * EM cujo `flush` falha DEPOIS de ter escrito as linhas na transação e
 * ANTES do commit — mas apenas quando uma `OutboxMessageEntity` já foi
 * persistida, isto é, no flush final do caso de uso. É o ponto em que a
 * atomicidade precisa valer (README §11: ou tudo confirma junto, ou nada).
 */
function emWithForcedPostFlushFailure(): EntityManager {
  const real = orm.em.fork();

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
        `${reconstructed.toJSON().amount} (restantes: ${JSON.stringify(
          pending.map((entry) => `${entry.balance_before}->${entry.balance_after}`,
        ))})`,
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
    const amount = Money.from({ amount: entry.amount, currency: entry.currency });
    const expected =
      entry.direction === LedgerDirection.CREDIT
        ? before.add(amount)
        : before.subtract(amount);

    expect(after.equals(expected)).toBe(true);
    reconstructed = after;
  }

  // Invariante final de todos os testes (README §13).
  expect(reconstructed.equals(stored)).toBe(true);

  let totalCredit = Money.zero(wallet.currency);
  let totalDebit = Money.zero(wallet.currency);

  for (const entry of entries) {
    const amount = Money.from({ amount: entry.amount, currency: entry.currency });

    if (entry.direction === LedgerDirection.CREDIT) {
      totalCredit = totalCredit.add(amount);
    } else {
      totalDebit = totalDebit.add(amount);
    }
  }

  expect(totalCredit.subtract(totalDebit).equals(stored)).toBe(true);

  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const entryTransactionIds = new Set(entries.map((entry) => entry.transaction_id));

  for (const transaction of transactions) {
    const hasEntry = entryTransactionIds.has(transaction.id);
    const generatesLedger =
      transaction.kind === WagerTransactionKind.OPENING ||
      transaction.kind === WagerTransactionKind.BET ||
      transaction.kind === WagerTransactionKind.WIN;

    if (generatesLedger && transaction.status === WagerTransactionStatus.PROCESSED) {
      expect(hasEntry).toBe(true);
    }

    // REJECTED e PENDING_REFERENCE não alteram saldo nem geram lançamento
    // (README §7, regras 6 e 8).
    if (
      transaction.status === WagerTransactionStatus.REJECTED ||
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
      transactionById.get(entry.transaction_id)?.kind !== WagerTransactionKind.OPENING,
  );
  expect(wallet.version).toBe(1 + nonOpeningEntries.length);
}

describe('WIN sem referência — PostgreSQL real', () => {
  it('credita com CREDIT, persiste PROCESSED e emite os eventos na mesma transação', async () => {
    const playerId = `it-win-plain-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const result = await processWin(winInput(wallet.id, playerId));

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(2);
    expect(result.replayed).toBe(false);

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('125.00');
    expect(walletRow.version).toBe(2);

    const wins = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.WIN,
    );
    expect(wins).toHaveLength(1);
    expect(wins[0]!.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(wins[0]!.amount).toBe('25.00');
    expect(wins[0]!.reference_external_transaction_id).toBeNull();
    expect(wins[0]!.reference_transaction_id).toBeNull();
    expect(wins[0]!.processed_at).not.toBeNull();
    expect(wins[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    const entries = await readLedgerRows(wallet.id);
    expect(entries).toHaveLength(2); // abertura + WIN
    const credits = entries.filter(
      (entry) => entry.direction === LedgerDirection.CREDIT,
    );
    expect(credits).toHaveLength(2);
    expect(credits[1]!.amount).toBe('25.00');
    expect(credits[1]!.balance_before).toBe('100.00');
    expect(credits[1]!.balance_after).toBe('125.00');

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('WIN inválida (payload ou valor) é recusada antes de tocar o banco', async () => {
    const playerId = `it-win-invalid-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await expect(
      processWin({ ...winInput(wallet.id, playerId), roundId: '' }),
    ).rejects.toThrow('INVALID_ROUNDID');
    await expect(
      processWin({
        ...winInput(wallet.id, playerId),
        referenceExternalTransactionId: '   ',
      }),
    ).rejects.toThrow('INVALID_REFERENCEEXTERNALTRANSACTIONID');
    await expect(
      processWin({ ...winInput(wallet.id, playerId), amount: '0.00' }),
    ).rejects.toThrow('WIN amount must be positive');

    // Só a abertura existe: nenhuma WIN, nenhum lançamento novo, nenhum
    // evento além do da abertura.
    expect(
      (await readTransactionRows(wallet.id)).filter(
        (row) => row.kind === WagerTransactionKind.WIN,
      ),
    ).toHaveLength(0);
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);
    expect((await readWalletRow(wallet.id)).balance).toBe('100.00');
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
    });
  });
});

describe('WIN com referência inexistente — PostgreSQL real', () => {
  it('persiste PENDING_REFERENCE com o evento aprovado e nenhum efeito de saldo', async () => {
    const playerId = `it-win-pending-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const result = await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: 'bet-never-seen',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(1);

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('100.00');
    expect(walletRow.version).toBe(1);

    const wins = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.WIN,
    );
    expect(wins).toHaveLength(1);
    expect(wins[0]!.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(wins[0]!.reference_external_transaction_id).toBe('bet-never-seen');
    // Sem alvo não há FK interna (o schema aceita nulo em qualquer kind).
    expect(wins[0]!.reference_transaction_id).toBeNull();
    expect(wins[0]!.processed_at).toBeNull();
    expect(wins[0]!.rejection_reason).toBeNull();
    expect(wins[0]!.result_balance_amount).toBe('100.00');

    // Regra 8: nenhum lançamento além do da abertura.
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
      WagerTransactionPendingReference: 1,
    });

    // Payload "Opção A" serializado pelo PostgreSQL real.
    const pending = (await connection().execute(
      `select event_type, aggregate_id, status, payload from outbox_messages
       where event_type = 'WagerTransactionPendingReference'`,
    )) as OutboxRow[];

    expect(pending).toHaveLength(1);
    expect(pending[0]!.aggregate_id).toBe(result.transactionId);
    expect(pending[0]!.status).toBe('PENDING');
    expect(pending[0]!.payload.version).toBe(1);
    expect(pending[0]!.payload.correlationId).toBe(result.transactionId);
    expect(pending[0]!.payload.data).toEqual({
      transactionId: result.transactionId,
      playerId,
      walletId: wallet.id,
      kind: WagerTransactionKind.WIN,
      status: WagerTransactionStatus.PENDING_REFERENCE,
      amount: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-never-seen',
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('replay devolve PENDING_REFERENCE mesmo depois de a referência chegar', async () => {
    const playerId = `it-win-pending-replay-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const referenceId = `bet-${randomUUID()}`;
    const input = winInput(wallet.id, playerId, {
      referenceExternalTransactionId: referenceId,
      roundId: 'round-shared',
    });

    const first = await processWin(input);
    expect(first.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    // A referência "chega depois": a BET correspondente é processada.
    const bet = await processBet(
      betInput(wallet.id, playerId, {
        externalTransactionId: referenceId,
        roundId: 'round-shared',
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);

    const second = await processWin(input);

    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    // O replay NÃO resolve: a linha continua aguardando o worker de §7.1.
    const wins = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.WIN,
    );
    expect(wins).toHaveLength(1);
    expect(wins[0]!.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(wins[0]!.reference_transaction_id).toBeNull();

    // O replay não acrescentou efeito algum: saldo só mudou pela BET.
    expect((await readWalletRow(wallet.id)).balance).toBe('90.00');
    expect(await readLedgerRows(wallet.id)).toHaveLength(2); // abertura + BET
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
      WagerTransactionPendingReference: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });
});

describe('WIN com referência compatível — PostgreSQL real', () => {
  it('resolve a BET da mesma rodada, credita e grava a FK interna', async () => {
    const playerId = `it-win-resolved-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const referenceId = `bet-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;

    const bet = await processBet(
      betInput(wallet.id, playerId, {
        externalTransactionId: referenceId,
        roundId,
        amount: '10.00',
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(bet.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const result = await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: referenceId,
        roundId,
        amount: '25.00',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toEqual({ amount: '115.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(3);

    const betRow = (await readTransactionRows(wallet.id)).find(
      (row) => row.external_transaction_id === referenceId,
    )!;
    const winRow = (await readTransactionRows(wallet.id)).find(
      (row) => row.kind === WagerTransactionKind.WIN,
    )!;

    expect(winRow.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(winRow.reference_external_transaction_id).toBe(referenceId);
    // FK interna = id INTERNO da BET (README 6.3: "id no provedor — não o
    // id interno").
    expect(winRow.reference_transaction_id).toBe(betRow.id);
    expect(winRow.processed_at).not.toBeNull();

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('115.00');
    expect(walletRow.version).toBe(3);

    const entries = await readLedgerRows(wallet.id);
    expect(entries).toHaveLength(3); // abertura + débito da BET + crédito da WIN
    const lastEntry = entries.find(
      (entry) => entry.transaction_id === winRow.id,
    )!;
    expect(lastEntry.direction).toBe(LedgerDirection.CREDIT);
    expect(lastEntry.amount).toBe('25.00');
    expect(lastEntry.balance_before).toBe('90.00');
    expect(lastEntry.balance_after).toBe('115.00');

    // Nenhum evento pendente: a referência existia.
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 3,
      WagerTransactionProcessed: 2,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('divergência de rodada rejeita com REFERENCE_MISMATCH e não move saldo', async () => {
    const playerId = `it-win-mismatch-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const referenceId = `bet-${randomUUID()}`;

    const bet = await processBet(
      betInput(wallet.id, playerId, {
        externalTransactionId: referenceId,
        roundId: 'round-bet',
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(bet.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    // Mesmo provider, player, wallet e moeda — mas outra rodada (regra 2).
    const result = await processWin(
      winInput(wallet.id, playerId, {
        referenceExternalTransactionId: referenceId,
        roundId: 'round-win',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe('REFERENCE_MISMATCH');
    expect(result.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(2);

    const winRow = (await readTransactionRows(wallet.id)).find(
      (row) => row.kind === WagerTransactionKind.WIN,
    )!;
    expect(winRow.status).toBe(WagerTransactionStatus.REJECTED);
    expect(winRow.rejection_reason).toBe('REFERENCE_MISMATCH');
    expect(winRow.reference_transaction_id).toBeNull();
    expect(winRow.processed_at).toBeNull();

    // Regra 6: REJECTED não gera lançamento nem mexe no saldo.
    expect((await readWalletRow(wallet.id)).balance).toBe('90.00');
    expect((await readWalletRow(wallet.id)).version).toBe(2);
    expect(await readLedgerRows(wallet.id)).toHaveLength(2); // abertura + BET

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
      WagerTransactionRejected: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });
});

describe('Idempotência e concorrência de WIN — PostgreSQL real', () => {
  it('duas requisições concorrentes idênticas produzem um único crédito', async () => {
    const playerId = `it-win-race-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const input = winInput(wallet.id, playerId, { amount: '25.00' });

    const results = await Promise.all([processWin(input), processWin(input)]);

    // Mesma transação para as duas requisições; uma aplicou e a outra
    // recebeu o replay do resultado original (README §7, regra 7).
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.PROCESSED)).toBe(
      true,
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    for (const result of results) {
      expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });
      expect(result.walletVersion).toBe(2);
    }

    // Persistido: uma única WIN, um único crédito.
    const wins = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.WIN,
    );
    expect(wins).toHaveLength(1);

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('125.00');
    expect(walletRow.version).toBe(2);

    const credits = (await readLedgerRows(wallet.id)).filter(
      (entry) =>
        entry.direction === LedgerDirection.CREDIT &&
        entry.amount === '25.00',
    );
    expect(credits).toHaveLength(1);

    // Replays não emitem eventos: abertura + os dois da WIN vencedora.
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);

  it('mesma chave com payload diferente conflita, sem efeito parcial', async () => {
    const playerId = `it-win-conflict-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const input = winInput(wallet.id, playerId, { amount: '25.00' });
    await processWin(input);

    await expect(
      processWin({ ...input, amount: '30.00' }),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');

    // O conflito não produziu efeito algum.
    expect(
      (await readTransactionRows(wallet.id)).filter(
        (row) => row.kind === WagerTransactionKind.WIN,
      ),
    ).toHaveLength(1);
    expect((await readWalletRow(wallet.id)).balance).toBe('125.00');
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });
});

describe('Atomicidade da WIN — PostgreSQL real', () => {
  it('falha após o flush desfaz saldo, ledger, transação e outbox (rollback real)', async () => {
    const playerId = `it-win-rollback-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // Falha proposital DEPOIS do flush ter escrito as linhas na transação e
    // ANTES do commit — exatamente o ponto em que a atomicidade vale.
    await expect(
      new ProcessWinUseCase(emWithForcedPostFlushFailure()).execute(
        winInput(wallet.id, playerId),
      ),
    ).rejects.toThrow('FORCED_FAILURE_AFTER_OUTBOX_FLUSH');

    // Leitura por SQL cru: a transação inteira foi desfeita.
    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('100.00');
    expect(walletRow.version).toBe(1);

    expect(
      (await readTransactionRows(wallet.id)).filter(
        (row) => row.kind === WagerTransactionKind.WIN,
      ),
    ).toHaveLength(0);

    // Nenhum lançamento além do da abertura.
    expect(await readLedgerRows(wallet.id)).toHaveLength(1);

    // Nenhum evento da WIN: o outbox também foi desfeito.
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('após a falha, a mesma WIN é aplicada normalmente pela rota de produção', async () => {
    const playerId = `it-win-recovery-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const input = winInput(wallet.id, playerId, { amount: '25.00' });

    await expect(
      new ProcessWinUseCase(emWithForcedPostFlushFailure()).execute(input),
    ).rejects.toThrow('FORCED_FAILURE_AFTER_OUTBOX_FLUSH');

    // Nada persistiu, então a chave de idempotência está livre: o reenvio
    // (at-least-once) aplica a WIN de novo, sem duplicar efeito.
    const result = await processWin(input);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.replayed).toBe(false);
    expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });

    expect((await readWalletRow(wallet.id)).balance).toBe('125.00');
    expect(
      (await readTransactionRows(wallet.id)).filter(
        (row) => row.kind === WagerTransactionKind.WIN,
      ),
    ).toHaveLength(1);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });
});
