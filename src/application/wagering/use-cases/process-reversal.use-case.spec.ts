import {
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import {
  ProcessReversalInput,
  ProcessReversalUseCase,
} from './process-reversal.use-case.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-24T12:00:00.000Z');

function seededWalletRow() {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance: '100.00',
    version: 2,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
  };
}

function seededBet() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    wallet: { __reference: true, entityClass: WalletEntity, id: WALLET_ID },
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'provider-a:bet-1',
    payloadHash: 'b'.repeat(64),
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.BET,
    status: WagerTransactionStatus.PROCESSED,
    amount: '30.00',
    currency: 'BRL',
    referenceExternalTransactionId: null,
    referenceTransaction: null,
    rejectionReason: null,
    processedAt: NOW,
    resultBalanceAmount: '70.00',
    resultBalanceCurrency: 'BRL',
    resultWalletVersion: 2,
    referenceAttempts: 0,
    referenceNextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function input(overrides: Partial<ProcessReversalInput> = {}): ProcessReversalInput {
  return {
    kind: WagerTransactionKind.REFUND,
    walletId: WALLET_ID,
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: `rev-${Math.random().toString(16).slice(2)}`,
    idempotencyKey: `key-${Math.random().toString(16).slice(2)}`,
    amount: '30.00',
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    referenceExternalTransactionId: 'bet-1',
    ...overrides,
  };
}

function readyFake(): FakeEntityManager {
  const fake = new FakeEntityManager();
  fake.seed(WalletEntity, seededWalletRow());
  fake.seed(WagerTransactionEntity, seededBet());

  return fake;
}

describe('ProcessReversalUseCase — conflito da regra 4', () => {
  let errorSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('violação da unique de reversão vira REJECTED auditado e 409', async () => {
    const fake = readyFake();

    // 1º flush = transação financeira: perde a corrida do índice único e é
    // revertida por inteiro. 2º flush = auditoria, em transação própria.
    let flushes = 0;
    fake.flush = async () => {
      flushes += 1;

      if (flushes === 1) {
        throw new UniqueConstraintViolationException(
          new Error(
            'duplicate key value violates unique constraint "wager_transactions_reversal_unique"',
          ),
        );
      }

      return FakeEntityManager.prototype.flush.call(fake);
    };

    const result = await new ProcessReversalUseCase(
      fake.asEntityManager(),
    ).execute(input());

    // A tentativa perdedora vira uma linha REJECTED auditável e a resposta de
    // domínio é a mesma que o replay devolverá depois (§9).
    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    const rows = fake.rows<Record<string, unknown>>(WagerTransactionEntity);
    expect(rows).toHaveLength(2);
    const audit = rows.find(
      (row) => row['rejectionReason'] === FailureCode.REFERENCE_ALREADY_REVERSED,
    );
    expect(audit).toBeDefined();
    expect(audit!['status']).toBe(WagerTransactionStatus.REJECTED);
  });

  it('falha genérica de banco não vira REFERENCE_ALREADY_REVERSED', async () => {
    const fake = readyFake();
    fake.beforeFlush = () => {
      throw new Error('SIMULATED_DB_OUTAGE');
    };

    await expect(
      new ProcessReversalUseCase(fake.asEntityManager()).execute(input()),
    ).rejects.toThrow('SIMULATED_DB_OUTAGE');

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('falha ao persistir a auditoria preserva o conflito e fica observável', async () => {
    const fake = readyFake();

    // 1º flush = transação financeira (perde a corrida); 2º = auditoria (falha).
    let flushes = 0;
    fake.flush = async () => {
      flushes += 1;

      if (flushes === 1) {
        throw new UniqueConstraintViolationException(
          new Error(
            'duplicate key value violates unique constraint "wager_transactions_reversal_unique"',
          ),
        );
      }

      throw new Error('SIMULATED_AUDIT_OUTAGE');
    };

    // O conflito financeiro continua sendo reportado…
    await expect(
      new ProcessReversalUseCase(fake.asEntityManager()).execute(input()),
    ).rejects.toThrow('REFERENCE_ALREADY_REVERSED');

    // …e a falha de auditoria fica observável, sem afirmar persistência.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]![0]);
    expect(logged).toContain('não persistida');
    expect(logged).toContain('SIMULATED_AUDIT_OUTAGE');
  });
});
