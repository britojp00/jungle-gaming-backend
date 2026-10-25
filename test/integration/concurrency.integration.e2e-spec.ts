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
  ProcessBetResult,
  ProcessBetUseCase,
} from '../../src/application/wagering/use-cases/process-bet.use-case.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { LedgerDirection } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
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
 * Testes de concorrência contra o PostgreSQL REAL do ambiente isolado.
 *
 * Cada "requisição" concorrente recebe o seu próprio EntityManager
 * (`orm.em.fork()`), como em um processo HTTP real: cada transação roda em
 * conexão própria do pool, com locks de linha do banco — nada de execução
 * sequencial disfarçada nem de mocks.
 *
 * Todo o estado asserted vem de SQL cru (fora do identity map), e toda a
 * aritmética monetária usa `Money` com strings decimais — nunca `number`.
 *
 * Invariante final de todos os cenários (README 13):
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
  idempotency_key: string | null;
  payload_hash: string | null;
  round_id: string | null;
  game_id: string | null;
  rejection_reason: string | null;
  result_balance_amount: string | null;
  processed_at: Date | null;
}

interface OutboxRow {
  event_type: string;
  status: string;
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
     from wallet_ledger_entries where wallet_id = '${walletId}'`,
  )) as LedgerRow[];
}

async function readTransactionRows(walletId: string): Promise<TransactionRow[]> {
  return (await connection().execute(
    `select id, kind, status, amount, currency, provider_id, idempotency_key,
            payload_hash, round_id, game_id, rejection_reason,
            result_balance_amount, processed_at
     from wager_transactions where wallet_id = '${walletId}'`,
  )) as TransactionRow[];
}

async function readOutboxRows(): Promise<OutboxRow[]> {
  return (await connection().execute(
    `select event_type, status from outbox_messages`,
  )) as OutboxRow[];
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
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `key-${id}`,
    amount: '80.00',
    currency: 'BRL',
    // Obrigatórios pelo README 6.3/§9 — ver `ProcessBetInput`.
    roundId: `round-${id}`,
    gameId: 'fortune-chimp',
    ...overrides,
  };
}

function processBet(input: ProcessBetInput): Promise<ProcessBetResult> {
  return new ProcessBetUseCase(requestEm()).execute(input);
}

function fulfilled<T>(results: PromiseSettledResult<T>[]): PromiseFulfilledResult<T>[] {
  return results.filter(
    (result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled',
  );
}

function rejected(results: PromiseSettledResult<unknown>[]): PromiseRejectedResult[] {
  return results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
}

function countByEventType(rows: OutboxRow[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
  }

  return counts;
}

/**
 * Consistência final persistida de uma wallet, lida exclusivamente por SQL cru.
 *
 * Verifica, contra os dados reais do PostgreSQL:
 * 1. saldo materializado nunca negativo;
 * 2. cadeia do ledger: cada lançamento parte do saldo em que o anterior
 *    terminou (a ordem é reconstruída varrendo, sem depender de timestamp),
 *    e cada linha satisfaz `before ± amount === after`;
 * 3. `wallet.balance == saldo reconstruído pelo ledger` (invariante final
 *    de todos os testes, README 13);
 * 4. reconciliação independente por soma: `credit − debit == saldo`;
 * 5. toda transação REJECTED não tem lançamento, e todo lançamento pertence
 *    a uma transação PROCESSSED;
 * 6. `version == 1 + lançamentos que não sejam da abertura` — a abertura
 *    cria a wallet em `version = 1` e cada movimentação incrementa (README 6.2).
 */
async function assertWalletLedgerConsistency(walletId: string): Promise<void> {
  const wallet = await readWalletRow(walletId);
  const stored = Money.from({
    amount: wallet.balance,
    currency: wallet.currency,
  });

  // 1. Saldo materializado nunca negativo (reforçado também pela CHECK
  //    `wallets_balance_non_negative` do banco).
  expect(stored.isNegative()).toBe(false);

  const entries = await readLedgerRows(walletId);
  const transactions = await readTransactionRows(walletId);

  for (const entry of entries) {
    expect(entry.currency).toBe(wallet.currency);
  }

  // 2. Cadeia do lançamentos: reconstrói a sequência partindo de zero.
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
          pending.map((entry) => `${entry.balance_before}->${entry.balance_after}`),
        )})`,
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

  // 3. Saldo materializado == saldo reconstruído pelo ledger.
  expect(reconstructed.equals(stored)).toBe(true);

  // 4. Soma independente: credit − debit == saldo materializado.
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

  // 5. REJECTED não gera lançamento; todo lançamento pertence a uma
  //    transação PROCESSSED da própria carteira.
  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const entryTransactionIds = new Set(entries.map((entry) => entry.transaction_id));

  for (const transaction of transactions) {
    const hasEntry = entryTransactionIds.has(transaction.id);
    const generatesLedger =
      transaction.kind === WagerTransactionKind.OPENING ||
      transaction.kind === WagerTransactionKind.BET;

    if (generatesLedger && transaction.status === WagerTransactionStatus.PROCESSED) {
      expect(hasEntry).toBe(true);
    }

    if (transaction.status === WagerTransactionStatus.REJECTED) {
      expect(hasEntry).toBe(false);
    }
  }

  for (const entry of entries) {
    expect(transactionById.get(entry.transaction_id)?.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
  }

  // 6. Versão: abertura nasce em 1 e cada movimentação incrementa.
  const nonOpeningEntries = entries.filter(
    (entry) =>
      transactionById.get(entry.transaction_id)?.kind !== WagerTransactionKind.OPENING,
  );
  expect(wallet.version).toBe(1 + nonOpeningEntries.length);
}

describe('Concorrência de BET na mesma wallet — PostgreSQL real', () => {
  it('BET sem roundId ou gameId é recusada como payload inválido, sem efeito no banco', async () => {
    const playerId = `it-invalid-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await expect(
      processBet({ ...betInput(wallet.id, playerId), roundId: '' }),
    ).rejects.toThrow('INVALID_ROUNDID');
    await expect(
      processBet({ ...betInput(wallet.id, playerId), gameId: '   ' }),
    ).rejects.toThrow('INVALID_GAMEID');

    // Nenhum efeito persistido: só a abertura existe.
    const bets = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.BET,
    );
    expect(bets).toHaveLength(0);
    expect(await readLedgerRows(wallet.id)).toHaveLength(1); // só o CREDIT da abertura
    expect((await readWalletRow(wallet.id)).balance).toBe('100.00');
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
    });
  });

  it('duas apostas de 80.00 simultâneas sobre saldo 100.00: uma PROCESSADA, outra REJECTED, saldo 20.00', async () => {
    const playerId = `it-race-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const results = await Promise.all([
      processBet(betInput(wallet.id, playerId)),
      processBet(betInput(wallet.id, playerId)),
    ]);

    // Exatamente uma aprovada e uma rejeitada (cenário obrigatório, README 8).
    expect(
      results.map((result) => result.status).sort(),
    ).toEqual([WagerTransactionStatus.PROCESSED, WagerTransactionStatus.REJECTED]);

    const rejectedResult = results.find(
      (result) => result.status === WagerTransactionStatus.REJECTED,
    )!;
    expect(rejectedResult.failureCode).toBe('INSUFFICIENT_FUNDS');

    // Estado persistido, lido por SQL cru.
    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('20.00');
    expect(walletRow.version).toBe(2);

    const entries = await readLedgerRows(wallet.id);
    const debits = entries.filter((entry) => entry.direction === LedgerDirection.DEBIT);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe('80.00');

    const bets = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.BET,
    );
    expect(bets).toHaveLength(2);
    expect(
      bets.map((bet) => bet.status).sort(),
    ).toEqual([WagerTransactionStatus.PROCESSED, WagerTransactionStatus.REJECTED]);

    // Rodada e jogo persistidos a partir do domínio (README 6.3 e §9).
    expect(bets.every((bet) => bet.round_id !== null)).toBe(true);
    expect(bets.every((bet) => bet.game_id === 'fortune-chimp')).toBe(true);

    const rejectedRow = bets.find(
      (bet) => bet.status === WagerTransactionStatus.REJECTED,
    )!;
    expect(rejectedRow.rejection_reason).toBe('INSUFFICIENT_FUNDS');
    // REJECTED não foi aplicada: `reject(code)` não recebe data (README 6.3).
    expect(rejectedRow.processed_at).toBeNull();

    const processedRow = bets.find(
      (bet) => bet.status === WagerTransactionStatus.PROCESSED,
    )!;
    expect(processedRow.processed_at).not.toBeNull();

    // Outbox: abertura + evento da aprovada + evento da rejeitada. Nada duplicado.
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
      WagerTransactionRejected: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('cinco apostas de 80.00 concorrentes sobre saldo 100.00: exatamente uma aprovada', async () => {
    const playerId = `it-race-five-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => processBet(betInput(wallet.id, playerId))),
    );

    expect(
      results.filter((result) => result.status === WagerTransactionStatus.PROCESSED),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === WagerTransactionStatus.REJECTED),
    ).toHaveLength(4);

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('20.00');
    expect(walletRow.version).toBe(2);

    // Um único débito persistido, não um por requisição.
    const debits = (await readLedgerRows(wallet.id)).filter(
      (entry) => entry.direction === LedgerDirection.DEBIT,
    );
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe('80.00');

    const bets = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.BET,
    );
    expect(bets).toHaveLength(5);
    expect(
      bets.filter((bet) => bet.status === WagerTransactionStatus.PROCESSED),
    ).toHaveLength(1);
    expect(
      bets.filter((bet) => bet.rejection_reason === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(4);

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
      WagerTransactionRejected: 4,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const playerId = `it-replay-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // Mesmo conteúdo — mesma chave de idempotência, mesmo payload.
    const input = betInput(wallet.id, playerId, { amount: '10.00' });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processBet(input)),
    );

    // Todas as 50 requisições recebem a MESMA transação original.
    const transactionIds = new Set(results.map((result) => result.transactionId));
    expect(transactionIds.size).toBe(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.PROCESSED)).toBe(
      true,
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(49);

    // Persistido: uma única transação, um único débito, saldo único.
    const bets = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.BET,
    );
    expect(bets).toHaveLength(1);
    expect(bets[0]!.idempotency_key).toBe(input.idempotencyKey);
    expect(bets[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(bets[0]!.result_balance_amount).toBe('90.00');

    const debits = (await readLedgerRows(wallet.id)).filter(
      (entry) => entry.direction === LedgerDirection.DEBIT,
    );
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe('10.00');

    const walletRow = await readWalletRow(wallet.id);
    expect(walletRow.balance).toBe('90.00');
    expect(walletRow.version).toBe(2);

    // Replays não emitem eventos: só abertura + os dois da aposta vencedora.
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  }, 30_000);

  it('mesma chave de idempotência com conteúdos diferentes concorre para conflito, não replay', async () => {
    const playerId = `it-conflict-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const idempotencyKey = `conflict-${randomUUID()}`;
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: 'provider-a',
      idempotencyKey,
      currency: 'BRL',
      roundId: `round-${randomUUID()}`,
      gameId: 'fortune-chimp',
    };
    const first = {
      ...base,
      externalTransactionId: `ext-a-${randomUUID()}`,
      amount: '10.00',
    };
    const second = {
      ...base,
      externalTransactionId: `ext-b-${randomUUID()}`,
      amount: '20.00',
    };

    const settled = await Promise.allSettled([
      processBet(first),
      processBet(second),
    ]);

    // Exatamente uma vence; a outra recebe conflito explícito de idempotência.
    expect(fulfilled(settled)).toHaveLength(1);
    expect(rejected(settled)).toHaveLength(1);
    expect(rejected(settled)[0]!.reason).toBeInstanceOf(Error);
    expect((rejected(settled)[0]!.reason as Error).message).toBe(
      'IDEMPOTENCY_PAYLOAD_CONFLICT',
    );

    // Persistido: uma única transação para a chave, com o conteúdo do vencedor.
    const bets = (await readTransactionRows(wallet.id)).filter(
      (row) => row.kind === WagerTransactionKind.BET,
    );
    expect(bets).toHaveLength(1);
    expect(bets[0]!.idempotency_key).toBe(idempotencyKey);

    const winner = fulfilled(settled)[0]!.value;
    const winnerAmount = Money.from({
      amount: '100.00',
      currency: 'BRL',
    }).subtract(Money.from(winner.balance));
    expect(bets[0]!.amount).toBe(winnerAmount.toJSON().amount);

    // Um único débito, no valor do vencedor; o conflito não gerou efeito.
    const debits = (await readLedgerRows(wallet.id)).filter(
      (entry) => entry.direction === LedgerDirection.DEBIT,
    );
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe(winnerAmount.toJSON().amount);

    expect((await readWalletRow(wallet.id)).balance).toBe(winner.balance.amount);
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 2,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(wallet.id);
  });

  it('mesma chave de idempotência em carteiras diferentes com conteúdos diferentes conflita sem efeito parcial', async () => {
    const playerA = `it-shared-key-a-${randomUUID()}`;
    const playerB = `it-shared-key-b-${randomUUID()}`;
    const walletA = await openWallet(playerA, '100.00');
    const walletB = await openWallet(playerB, '100.00');

    const idempotencyKey = `shared-${randomUUID()}`;
    const requestA: ProcessBetInput = {
      walletId: walletA.id,
      playerId: playerA,
      providerId: 'provider-a',
      externalTransactionId: `ext-a-${randomUUID()}`,
      idempotencyKey,
      amount: '10.00',
      currency: 'BRL',
      roundId: `round-${randomUUID()}`,
      gameId: 'fortune-chimp',
    };
    const requestB: ProcessBetInput = {
      walletId: walletB.id,
      playerId: playerB,
      providerId: 'provider-a',
      externalTransactionId: `ext-b-${randomUUID()}`,
      idempotencyKey,
      amount: '20.00',
      currency: 'BRL',
      roundId: `round-${randomUUID()}`,
      gameId: 'fortune-chimp',
    };

    const settled = await Promise.allSettled([
      processBet(requestA),
      processBet(requestB),
    ]);

    // A chave é a fonte da verdade (README 9): mesma chave + payload
    // diferente conflita — mesmo que as requisições atinjam wallets distintas.
    expect(fulfilled(settled)).toHaveLength(1);
    expect(rejected(settled)).toHaveLength(1);
    expect((rejected(settled)[0]!.reason as Error).message).toBe(
      'IDEMPOTENCY_PAYLOAD_CONFLICT',
    );

    // Persistido: uma única transação para a chave, em uma única carteira.
    const rows = (await connection().execute(
      `select id, wallet_id, amount from wager_transactions where idempotency_key = '${idempotencyKey}'`,
    )) as { id: string; wallet_id: string; amount: string }[];
    expect(rows).toHaveLength(1);

    // A transação persistida pertence à requisição que venceu a corrida.
    const winnerRequest = settled[0]!.status === 'fulfilled' ? requestA : requestB;
    expect(rows[0]!.id).toBe(fulfilled(settled)[0]!.value.transactionId);
    expect(rows[0]!.wallet_id).toBe(winnerRequest.walletId);
    expect(rows[0]!.amount).toBe(winnerRequest.amount);

    // A carteira perdedora não teve nenhum efeito: saldo intacto e sem débito.
    const loserWalletId =
      winnerRequest.walletId === walletA.id ? walletB.id : walletA.id;
    const loserBalance = (await readWalletRow(loserWalletId)).balance;
    expect(loserBalance).toBe('100.00');
    expect(
      (await readLedgerRows(loserWalletId)).filter(
        (entry) => entry.direction === LedgerDirection.DEBIT,
      ),
    ).toHaveLength(0);

    // O conflito não produz evento: só os dois da abertura + os da vencedora.
    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 3,
      WagerTransactionProcessed: 1,
    });

    await assertWalletLedgerConsistency(walletA.id);
    await assertWalletLedgerConsistency(walletB.id);
  });
});

describe('Abertura concorrente de wallet — PostgreSQL real', () => {
  it('aberturas simultâneas com mesmo jogador e moeda criam exatamente uma carteira', async () => {
    const playerId = `it-open-race-${randomUUID()}`;

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        new OpenWalletUseCase(requestEm()).execute({
          playerId,
          initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
        }),
      ),
    );

    expect(fulfilled(settled)).toHaveLength(1);
    expect(rejected(settled)).toHaveLength(4);

    for (const result of rejected(settled)) {
      expect((result.reason as Error).message).toBe('WALLET_ALREADY_EXISTS');
    }

    // Persistido: uma única wallet, uma única OPENING, um único CREDIT.
    const walletRows = (await connection().execute(
      `select id, balance, version from wallets where player_id = '${playerId}'`,
    )) as Pick<WalletRow, 'id' | 'balance' | 'version'>[];
    expect(walletRows).toHaveLength(1);
    expect(walletRows[0]!.balance).toBe('100.00');
    expect(walletRows[0]!.version).toBe(1);

    const walletId = walletRows[0]!.id;
    expect(await readTransactionRows(walletId)).toHaveLength(1);

    const entries = await readLedgerRows(walletId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.CREDIT);
    expect(entries[0]!.amount).toBe('100.00');

    expect(countByEventType(await readOutboxRows())).toEqual({
      WalletBalanceChanged: 1,
    });

    await assertWalletLedgerConsistency(walletId);
  });
});

describe('Carteiras distintas em paralelo — PostgreSQL real', () => {
  it('apostas concorrentes em carteiras diferentes processam todas e mantêm cada uma consistente', async () => {
    const players = ['x', 'y', 'z'].map((suffix) => `it-parallel-${suffix}-${randomUUID()}`);
    const wallets = await Promise.all(
      players.map((playerId) => openWallet(playerId, '100.00')),
    );

    // As três apostas disputam wallets diferentes: nenhuma pode ser
    // rejeitada nem interferir nas demais.
    const results = await Promise.all(
      wallets.map((wallet, index) => processBet(betInput(wallet.id, players[index]!))),
    );

    expect(
      results.every((result) => result.status === WagerTransactionStatus.PROCESSED),
    ).toBe(true);

    for (const wallet of wallets) {
      const walletRow = await readWalletRow(wallet.id);
      expect(walletRow.balance).toBe('20.00');
      expect(walletRow.version).toBe(2);

      const debits = (await readLedgerRows(wallet.id)).filter(
        (entry) => entry.direction === LedgerDirection.DEBIT,
      );
      expect(debits).toHaveLength(1);
      expect(debits[0]!.amount).toBe('80.00');

      await assertWalletLedgerConsistency(wallet.id);
    }
  });
});
