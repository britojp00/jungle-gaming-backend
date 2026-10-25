import { describe, expect, it } from 'vitest';

import { FailureCode } from '../../domain/wagering/failure-code.js';
import { Money } from '../../domain/shared/value-objects/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { evaluateReversal } from './process-support.js';

function operation(
  overrides: {
    kind?: WagerTransactionKind;
    status?: WagerTransactionStatus;
    amount?: string;
  } = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: '33333333-3333-4333-8333-333333333333',
    walletId: '11111111-1111-4111-8111-111111111111',
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    payloadHash: 'a'.repeat(64),
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: overrides.kind ?? WagerTransactionKind.BET,
    money: Money.from({
      amount: overrides.amount ?? '30.00',
      currency: 'BRL',
    }),
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    status: overrides.status ?? WagerTransactionStatus.PROCESSED,
    failureCode: null,
    processedAt: new Date('2026-10-24T10:01:00.000Z'),
  });
}

function reversal(
  kind: WagerTransactionKind.REFUND | WagerTransactionKind.ROLLBACK,
  amount = '30.00',
): WagerTransaction {
  return operation({ kind, amount });
}

function evaluate(
  reversalKind: WagerTransactionKind.REFUND | WagerTransactionKind.ROLLBACK,
  target: WagerTransaction,
  options: { amount?: string; alreadyReversed?: boolean; balance?: string } = {},
) {
  return evaluateReversal({
    reversal: reversal(reversalKind, options.amount ?? '30.00'),
    target,
    amount: Money.from({
      amount: options.amount ?? '30.00',
      currency: 'BRL',
    }),
    walletBalance: Money.from({
      amount: options.balance ?? '100.00',
      currency: 'BRL',
    }),
    alreadyReversed: options.alreadyReversed ?? false,
  });
}

describe('evaluateReversal — elegibilidade da referência (§7)', () => {
  it('REFUND aplica crédito sobre uma BET processada', () => {
    expect(evaluate(WagerTransactionKind.REFUND, operation())).toEqual({
      outcome: 'apply',
      direction: LedgerDirection.CREDIT,
    });
  });

  it('ROLLBACK inverte BET (crédito) e WIN (débito)', () => {
    expect(evaluate(WagerTransactionKind.ROLLBACK, operation())).toEqual({
      outcome: 'apply',
      direction: LedgerDirection.CREDIT,
    });
    expect(
      evaluate(
        WagerTransactionKind.ROLLBACK,
        operation({ kind: WagerTransactionKind.WIN, amount: '30.00' }),
      ),
    ).toEqual({ outcome: 'apply', direction: LedgerDirection.DEBIT });
  });

  it('REFUND só reverte BET — WIN, LOSS e REFUND são inelegíveis', () => {
    for (const kind of [
      WagerTransactionKind.WIN,
      WagerTransactionKind.LOSS,
      WagerTransactionKind.REFUND,
    ]) {
      expect(evaluate(WagerTransactionKind.REFUND, operation({ kind }))).toEqual(
        { outcome: 'reject', failureCode: FailureCode.REFERENCE_MISMATCH },
      );
    }
  });

  it('referência que não está PROCESSED é inelegível', () => {
    for (const status of [
      WagerTransactionStatus.REJECTED,
      WagerTransactionStatus.PENDING_REFERENCE,
      WagerTransactionStatus.FAILED,
    ]) {
      expect(
        evaluate(
          WagerTransactionKind.REFUND,
          operation({ status }),
        ),
      ).toEqual({
        outcome: 'reject',
        failureCode: FailureCode.REFERENCE_MISMATCH,
      });
    }
  });

  it('valor diferente do da referência é rejeitado', () => {
    expect(evaluate(WagerTransactionKind.REFUND, operation(), { amount: '25.00' })).toEqual(
      { outcome: 'reject', failureCode: FailureCode.REFERENCE_AMOUNT_MISMATCH },
    );
  });

  it('referência já revertida (qualquer tipo) é rejeitada', () => {
    expect(
      evaluate(WagerTransactionKind.ROLLBACK, operation(), {
        alreadyReversed: true,
      }),
    ).toEqual({
      outcome: 'reject',
      failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
    });
  });

  it('reversão que negativaria o saldo usa o failureCode próprio', () => {
    expect(
      evaluate(
        WagerTransactionKind.ROLLBACK,
        operation({ kind: WagerTransactionKind.WIN }),
        { balance: '10.00' },
      ),
    ).toEqual({
      outcome: 'reject',
      failureCode: FailureCode.INSUFFICIENT_BALANCE_FOR_REVERSAL,
    });
  });
});
