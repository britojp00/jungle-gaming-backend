import { describe, expect, it } from 'vitest';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { InvalidTransactionStateError } from '../shared/errors/invalid-transaction-state-error.js';
import { Money } from '../shared/value-objects/money.js';
import { FailureCode } from './failure-code.js';
import type {
  CreateExternalTransactionProps,
  CreateRefundTransactionProps,
  CreateRollbackTransactionProps,
  RehydrateWagerTransactionProps,
} from './wager-transaction.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

const date = new Date('2026-10-24T12:00:00.000Z');
const later = new Date('2026-10-24T13:00:00.000Z');

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function openingProps() {
  return {
    id: 'transaction-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    money: money('1000.00'),
    createdAt: date,
  };
}

function externalProps(
  overrides: Partial<CreateExternalTransactionProps> = {},
): CreateExternalTransactionProps {
  return {
    id: 'transaction-2',
    walletId: 'wallet-1',
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-456',
    idempotencyKey: 'provider-a:transaction-456',
    payloadHash: 'b'.repeat(64),
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    money: money('25.00'),
    createdAt: date,
    ...overrides,
  };
}

/** Props de REFUND/ROLLBACK: a referência externa é obrigatória (§7, r.1). */
function reversalProps(
  overrides: Partial<CreateRefundTransactionProps> = {},
): CreateRefundTransactionProps {
  return {
    ...externalProps(),
    referenceExternalTransactionId: 'bet-789',
    ...overrides,
  };
}

function persistedProps(
  overrides: Partial<RehydrateWagerTransactionProps> = {},
): RehydrateWagerTransactionProps {
  return {
    ...externalProps(),
    // Obrigatório explícito: o retorno de externalProps marca a data como
    // opcional e a reidratação exige a data real da persistência.
    createdAt: date,
    kind: WagerTransactionKind.BET,
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    status: WagerTransactionStatus.PENDING,
    failureCode: null,
    processedAt: null,
    ...overrides,
  };
}

describe('WagerTransaction.createOpening', () => {
  it('creates an OPENING transaction already processed', () => {
    const transaction = WagerTransaction.createOpening(openingProps());

    expect(transaction.id).toBe('transaction-1');
    expect(transaction.walletId).toBe('wallet-1');
    expect(transaction.playerId).toBe('player-1');
    expect(transaction.kind).toBe(WagerTransactionKind.OPENING);
    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.processedAt).toEqual(date);
    expect(transaction.createdAt).toEqual(date);
    expect(transaction.money.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
    expect(transaction.isTerminal()).toBe(true);
  });

  it('leaves provider and idempotency metadata empty', () => {
    const transaction = WagerTransaction.createOpening(openingProps());

    expect(transaction.providerId).toBeNull();
    expect(transaction.externalTransactionId).toBeNull();
    expect(transaction.idempotencyKey).toBeNull();
    expect(transaction.payloadHash).toBeNull();
  });

  it('ignores provider metadata passed by mistake', () => {
    // Variável (e não literal) para contornar a checagem de propriedades
    // excedentes do TypeScript e provar que a factory descarta os dados.
    const propsWithProvider = {
      ...openingProps(),
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
    };

    const transaction =
      WagerTransaction.createOpening(propsWithProvider);

    expect(transaction.providerId).toBeNull();
    expect(transaction.externalTransactionId).toBeNull();
    expect(transaction.idempotencyKey).toBeNull();
  });

  it('does not require an external reference', () => {
    const transaction = WagerTransaction.createOpening(openingProps());

    expect(transaction.referenceExternalTransactionId).toBeNull();
    expect(transaction.requiresReference()).toBe(false);
  });

  it('is not tied to a round or game', () => {
    const transaction = WagerTransaction.createOpening(openingProps());

    expect(transaction.roundId).toBeNull();
    expect(transaction.gameId).toBeNull();
  });

  it('defaults createdAt to the current time when omitted', () => {
    const transaction = WagerTransaction.createOpening({
      ...openingProps(),
      createdAt: undefined,
    });

    expect(transaction.createdAt).toBeInstanceOf(Date);
    expect(transaction.createdAt.getTime()).not.toBeNaN();
    expect(transaction.processedAt).toEqual(transaction.createdAt);
  });

  it('rejects a zero opening amount', () => {
    expect(() =>
      WagerTransaction.createOpening({
        ...openingProps(),
        money: Money.zero('BRL'),
      }),
    ).toThrow('OPENING amount must be positive');
  });

  it('rejects a negative opening amount', () => {
    expect(() =>
      WagerTransaction.createOpening({
        ...openingProps(),
        money: money('10.00').negate(),
      }),
    ).toThrow('OPENING amount must be positive');
  });

  it('rejects a missing transaction, wallet or player id', () => {
    expect(() =>
      WagerTransaction.createOpening({ ...openingProps(), id: '' }),
    ).toThrow('Transaction ID is required');

    expect(() =>
      WagerTransaction.createOpening({
        ...openingProps(),
        walletId: '   ',
      }),
    ).toThrow('Wallet ID is required');

    expect(() =>
      WagerTransaction.createOpening({ ...openingProps(), playerId: '' }),
    ).toThrow('Player ID is required');
  });

  it('rejects an invalid creation date', () => {
    expect(() =>
      WagerTransaction.createOpening({
        ...openingProps(),
        createdAt: new Date(Number.NaN),
      }),
    ).toThrow('Invalid date');
  });
});

describe('WagerTransaction.createBet', () => {
  it('creates a BET in PENDING with provider metadata', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    expect(transaction.kind).toBe(WagerTransactionKind.BET);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.processedAt).toBeNull();
    expect(transaction.failureCode).toBeNull();
    expect(transaction.referenceTransactionId).toBeNull();
    expect(transaction.providerId).toBe('provider-a');
    expect(transaction.externalTransactionId).toBe('transaction-456');
    expect(transaction.idempotencyKey).toBe('provider-a:transaction-456');
    expect(transaction.payloadHash).toBe('b'.repeat(64));
    expect(transaction.roundId).toBe('round-987');
    expect(transaction.gameId).toBe('fortune-chimp');
    expect(transaction.referenceExternalTransactionId).toBeNull();
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.requiresReference()).toBe(false);
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.DEBIT);
    expect(transaction.createdAt).toEqual(date);
  });

  it('rejects missing provider and idempotency fields', () => {
    expect(() =>
      WagerTransaction.createBet(externalProps({ providerId: '' })),
    ).toThrow('Provider ID is required');

    expect(() =>
      WagerTransaction.createBet(
        externalProps({ externalTransactionId: '   ' }),
      ),
    ).toThrow('External transaction ID is required');

    expect(() =>
      WagerTransaction.createBet(externalProps({ idempotencyKey: '' })),
    ).toThrow('Idempotency key is required');
  });

  it('rejects a missing round or game (README 6.3 e §3)', () => {
    expect(() =>
      WagerTransaction.createBet(externalProps({ roundId: '' })),
    ).toThrow('Round ID is required');

    expect(() =>
      WagerTransaction.createBet(externalProps({ gameId: '  ' })),
    ).toThrow('Game ID is required');
  });

  it('rejects a malformed payload hash', () => {
    expect(() =>
      WagerTransaction.createBet(externalProps({ payloadHash: '' })),
    ).toThrow('Payload hash must be a 64-character lowercase hex digest');

    expect(() =>
      WagerTransaction.createBet(externalProps({ payloadHash: 'b'.repeat(63) })),
    ).toThrow('Payload hash must be a 64-character lowercase hex digest');

    // O algoritmo adotado é SHA-256 em hexadecimal minúsculo.
    expect(() =>
      WagerTransaction.createBet(externalProps({ payloadHash: 'B'.repeat(64) })),
    ).toThrow('Payload hash must be a 64-character lowercase hex digest');
  });

  it('accepts values exactly at the column length limits', () => {
    const transaction = WagerTransaction.createBet(
      externalProps({
        providerId: 'p'.repeat(100),
        externalTransactionId: 'e'.repeat(255),
        idempotencyKey: 'k'.repeat(255),
        roundId: 'r'.repeat(255),
        gameId: 'g'.repeat(255),
      }),
    );

    expect(transaction.providerId).toHaveLength(100);
  });

  it('rejects values above the column length limits', () => {
    expect(() =>
      WagerTransaction.createBet(
        externalProps({ providerId: 'p'.repeat(101) }),
      ),
    ).toThrow('Provider ID must be at most 100 characters');

    expect(() =>
      WagerTransaction.createBet(
        externalProps({ roundId: 'r'.repeat(256) }),
      ),
    ).toThrow('Round ID must be at most 255 characters');
  });

  it('rejects a zero or negative amount', () => {
    expect(() =>
      WagerTransaction.createBet(externalProps({ money: Money.zero('BRL') })),
    ).toThrow('BET amount must be positive');

    expect(() =>
      WagerTransaction.createBet(
        externalProps({ money: money('25.00').negate() }),
      ),
    ).toThrow('BET amount must be positive');
  });

  it('rejects a reference (nenhuma regra do README a justifica em BET)', () => {
    // Variável para contornar a checagem de propriedades excedentes.
    const withReference = {
      ...externalProps(),
      referenceExternalTransactionId: 'bet-789',
    };

    expect(() => WagerTransaction.createBet(withReference)).toThrow(
      'BET does not support a reference',
    );
  });

  it('rejects an invalid creation date', () => {
    expect(() =>
      WagerTransaction.createBet(
        externalProps({ createdAt: new Date(Number.NaN) }),
      ),
    ).toThrow('Invalid date');
  });

  it('defaults createdAt to the current time when omitted', () => {
    const transaction = WagerTransaction.createBet(
      externalProps({ createdAt: undefined }),
    );

    expect(transaction.createdAt).toBeInstanceOf(Date);
    expect(transaction.createdAt.getTime()).not.toBeNaN();
  });
});

describe('WagerTransaction.createWin', () => {
  it('creates a WIN without a reference by default', () => {
    const transaction = WagerTransaction.createWin(externalProps());

    expect(transaction.kind).toBe(WagerTransactionKind.WIN);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.referenceExternalTransactionId).toBeNull();
    expect(transaction.requiresReference()).toBe(false);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
  });

  it('stores an optional reference to the BET of the round', () => {
    const transaction = WagerTransaction.createWin({
      ...externalProps(),
      referenceExternalTransactionId: 'bet-789',
    });

    expect(transaction.referenceExternalTransactionId).toBe('bet-789');
    expect(transaction.requiresReference()).toBe(false);
  });

  it('rejects an empty reference string', () => {
    expect(() =>
      WagerTransaction.createWin({
        ...externalProps(),
        referenceExternalTransactionId: '   ',
      }),
    ).toThrow('Reference external transaction ID must not be empty');
  });
});

describe('WagerTransaction.createLoss', () => {
  it('creates a LOSS that does not move the balance', () => {
    const transaction = WagerTransaction.createLoss(externalProps());

    expect(transaction.kind).toBe(WagerTransactionKind.LOSS);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.affectsBalance()).toBe(false);
    expect(transaction.requiresReference()).toBe(false);
    expect(transaction.referenceExternalTransactionId).toBeNull();
    expect(transaction.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('does not generate ledger entries (README §6.4)', () => {
    const transaction = WagerTransaction.createLoss(externalProps());

    expect(() => transaction.ledgerDirectionFor()).toThrow(
      'LOSS does not generate ledger entries',
    );
  });

  it('rejects a zero amount (valor informativo da rodada)', () => {
    expect(() =>
      WagerTransaction.createLoss(externalProps({ money: Money.zero('BRL') })),
    ).toThrow('LOSS amount must be positive');
  });

  it('rejects a reference', () => {
    const withReference = {
      ...externalProps(),
      referenceExternalTransactionId: 'bet-789',
    };

    expect(() => WagerTransaction.createLoss(withReference)).toThrow(
      'LOSS does not support a reference',
    );
  });
});

describe('WagerTransaction.createRefund', () => {
  it('creates a REFUND in PENDING with a required reference', () => {
    const transaction = WagerTransaction.createRefund(reversalProps());

    expect(transaction.kind).toBe(WagerTransactionKind.REFUND);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.referenceExternalTransactionId).toBe('bet-789');
    expect(transaction.requiresReference()).toBe(true);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
  });

  it('rejects a missing reference (README §7, regra 1)', () => {
    // Cast simula um chamador que ignora o tipo (ex.: requisição externa):
    // a garantia precisa existir em runtime, não só no compilador.
    const withoutReference = externalProps() as CreateRefundTransactionProps;

    expect(() =>
      WagerTransaction.createRefund(withoutReference),
    ).toThrow('Reference external transaction ID is required');
  });

  it('rejects an empty reference string', () => {
    expect(() =>
      WagerTransaction.createRefund({
        ...externalProps(),
        referenceExternalTransactionId: '',
      }),
    ).toThrow('Reference external transaction ID must not be empty');
  });
});

describe('WagerTransaction.createRollback', () => {
  it('creates a ROLLBACK in PENDING with a required reference', () => {
    const transaction = WagerTransaction.createRollback(reversalProps());

    expect(transaction.kind).toBe(WagerTransactionKind.ROLLBACK);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.referenceExternalTransactionId).toBe('bet-789');
    expect(transaction.requiresReference()).toBe(true);
    expect(transaction.affectsBalance()).toBe(true);
  });

  it('rejects a missing reference (README §7, regra 1)', () => {
    // Cast simula um chamador que ignora o tipo (ex.: requisição externa):
    // a garantia precisa existir em runtime, não só no compilador.
    const withoutReference =
      externalProps() as CreateRollbackTransactionProps;

    expect(() =>
      WagerTransaction.createRollback(withoutReference),
    ).toThrow('Reference external transaction ID is required');
  });

  it('rejects an empty reference string', () => {
    expect(() =>
      WagerTransaction.createRollback({
        ...externalProps(),
        referenceExternalTransactionId: '  ',
      }),
    ).toThrow('Reference external transaction ID must not be empty');
  });
});

describe('WagerTransaction state transitions', () => {
  it('applies markProcessed from PENDING', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    transaction.markProcessed('reference-internal-1', later);

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.processedAt).toEqual(later);
    expect(transaction.referenceTransactionId).toBe('reference-internal-1');
    expect(transaction.isTerminal()).toBe(true);
  });

  it('applies markProcessed from PENDING_REFERENCE', () => {
    const transaction = WagerTransaction.createRefund(reversalProps());

    transaction.markPendingReference();
    transaction.markProcessed(undefined, later);

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.processedAt).toEqual(later);
    expect(transaction.referenceTransactionId).toBeNull();
  });

  it('rejects an invalid processedAt date', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    expect(() =>
      transaction.markProcessed(undefined, new Date(Number.NaN)),
    ).toThrow('Invalid date');
  });

  it('moves PENDING to PENDING_REFERENCE', () => {
    const transaction = WagerTransaction.createRefund(reversalProps());

    transaction.markPendingReference();

    expect(transaction.status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
    expect(transaction.isTerminal()).toBe(false);
  });

  it('keeps markPendingReference idempotent while already waiting', () => {
    const transaction = WagerTransaction.createRefund(reversalProps());

    transaction.markPendingReference();
    expect(() => transaction.markPendingReference()).not.toThrow();

    expect(transaction.status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
  });

  it('rejects a transaction with a failure code', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    transaction.reject(FailureCode.INSUFFICIENT_FUNDS);

    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.processedAt).toBeNull();
  });

  it('rejects a transaction that was waiting for a reference', () => {
    const transaction = WagerTransaction.createRefund(reversalProps());

    transaction.markPendingReference();
    transaction.reject(FailureCode.REFERENCE_NOT_FOUND);

    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
  });

  it('fails a transaction with a failure code', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    transaction.fail(FailureCode.INTERNAL_ERROR);

    expect(transaction.status).toBe(WagerTransactionStatus.FAILED);
    expect(transaction.failureCode).toBe(FailureCode.INTERNAL_ERROR);
    expect(transaction.isTerminal()).toBe(true);
  });

  it('rejects an empty failure code', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    expect(() =>
      transaction.reject('' as unknown as FailureCode),
    ).toThrow('Failure code is required');

    expect(() =>
      transaction.fail('' as unknown as FailureCode),
    ).toThrow('Failure code is required');
  });

  it('throws InvalidTransactionStateError for every transition from a terminal status', () => {
    const terminalStates: RehydrateWagerTransactionProps[] = [
      persistedProps({
        status: WagerTransactionStatus.PROCESSED,
        processedAt: date,
      }),
      persistedProps({
        status: WagerTransactionStatus.REJECTED,
        failureCode: FailureCode.INSUFFICIENT_FUNDS,
      }),
      persistedProps({
        status: WagerTransactionStatus.FAILED,
        failureCode: FailureCode.INTERNAL_ERROR,
      }),
    ];

    for (const props of terminalStates) {
      const transaction = WagerTransaction.rehydrate(props);

      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed('reference-1', later)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => transaction.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
      expect(() =>
        transaction.reject(FailureCode.INSUFFICIENT_FUNDS),
      ).toThrow(InvalidTransactionStateError);
      expect(() => transaction.fail(FailureCode.INTERNAL_ERROR)).toThrow(
        InvalidTransactionStateError,
      );
      // Nenhuma transição altera o estado terminal.
      expect(transaction.status).toBe(props.status);
    }
  });

  it('cannot transition an OPENING transaction (nasce terminal)', () => {
    const opening = WagerTransaction.createOpening(openingProps());

    expect(() => opening.markProcessed(undefined, later)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => opening.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      opening.reject(FailureCode.INSUFFICIENT_FUNDS),
    ).toThrow(InvalidTransactionStateError);
    expect(() => opening.fail(FailureCode.INTERNAL_ERROR)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransaction domain queries', () => {
  it('reports the balance effect of each kind (README §7)', () => {
    expect(
      WagerTransaction.createBet(externalProps()).affectsBalance(),
    ).toBe(true);
    expect(
      WagerTransaction.createWin(externalProps()).affectsBalance(),
    ).toBe(true);
    expect(
      WagerTransaction.createRefund(reversalProps()).affectsBalance(),
    ).toBe(true);
    expect(
      WagerTransaction.createRollback(reversalProps()).affectsBalance(),
    ).toBe(true);
    expect(
      WagerTransaction.createLoss(externalProps()).affectsBalance(),
    ).toBe(false);
    expect(
      WagerTransaction.createOpening(openingProps()).affectsBalance(),
    ).toBe(true);
  });

  it('requires a reference only for REFUND and ROLLBACK', () => {
    expect(
      WagerTransaction.createRefund(reversalProps()).requiresReference(),
    ).toBe(true);
    expect(
      WagerTransaction.createRollback(reversalProps()).requiresReference(),
    ).toBe(true);
    expect(
      WagerTransaction.createBet(externalProps()).requiresReference(),
    ).toBe(false);
    expect(
      WagerTransaction.createWin(externalProps()).requiresReference(),
    ).toBe(false);
    expect(
      WagerTransaction.createLoss(externalProps()).requiresReference(),
    ).toBe(false);
  });

  it('matches only an identical payload hash', () => {
    const transaction = WagerTransaction.createBet(externalProps());

    expect(transaction.matchesPayload('b'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('c'.repeat(64))).toBe(false);

    const opening = WagerTransaction.createOpening(openingProps());
    expect(opening.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('gives the ledger direction of every balance-affecting kind', () => {
    const betReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.BET }),
    );
    const winReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.WIN }),
    );
    const refundReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.REFUND }),
    );

    expect(betReference.ledgerDirectionFor()).toBe(LedgerDirection.DEBIT);
    expect(winReference.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    expect(refundReference.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    expect(
      WagerTransaction.createOpening(openingProps()).ledgerDirectionFor(),
    ).toBe(LedgerDirection.CREDIT);
  });

  it('inverts the reference direction on ROLLBACK (README §7)', () => {
    const rollback = () =>
      WagerTransaction.createRollback(reversalProps());
    const betReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.BET }),
    );
    const winReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.WIN }),
    );
    const refundReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.REFUND }),
    );

    // Reverter um débito credita; reverter um crédito debita.
    expect(rollback().ledgerDirectionFor(betReference)).toBe(
      LedgerDirection.CREDIT,
    );
    expect(rollback().ledgerDirectionFor(winReference)).toBe(
      LedgerDirection.DEBIT,
    );
    expect(rollback().ledgerDirectionFor(refundReference)).toBe(
      LedgerDirection.DEBIT,
    );
  });

  it('refuses to invert a reference that cannot be reversed (regra 3)', () => {
    const rollback = WagerTransaction.createRollback(reversalProps());
    const lossReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.LOSS }),
    );
    const rollbackReference = WagerTransaction.rehydrate(
      persistedProps({ kind: WagerTransactionKind.ROLLBACK }),
    );
    const openingReference = WagerTransaction.createOpening(openingProps());

    expect(() => rollback.ledgerDirectionFor()).toThrow(
      'ROLLBACK requires its reference transaction',
    );
    expect(() => rollback.ledgerDirectionFor(lossReference)).toThrow(
      'ROLLBACK can only invert a BET, WIN or REFUND transaction',
    );
    expect(() => rollback.ledgerDirectionFor(rollbackReference)).toThrow(
      'ROLLBACK can only invert a BET, WIN or REFUND transaction',
    );
    expect(() => rollback.ledgerDirectionFor(openingReference)).toThrow(
      'ROLLBACK can only invert a BET, WIN or REFUND transaction',
    );
  });
});

describe('WagerTransaction rehydration', () => {
  it('reconstructs a persisted OPENING transaction as-is', () => {
    const transaction = WagerTransaction.rehydrate({
      ...openingProps(),
      providerId: null,
      externalTransactionId: null,
      idempotencyKey: null,
      payloadHash: null,
      roundId: null,
      gameId: null,
      kind: WagerTransactionKind.OPENING,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: WagerTransactionStatus.PROCESSED,
      failureCode: null,
      processedAt: date,
    });

    expect(transaction.kind).toBe(WagerTransactionKind.OPENING);
    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.processedAt).toEqual(date);
    expect(transaction.roundId).toBeNull();
    expect(transaction.failureCode).toBeNull();
  });

  it('rehydrates persisted state without revalidating', () => {
    const transaction = WagerTransaction.rehydrate(persistedProps());

    expect(transaction.kind).toBe(WagerTransactionKind.BET);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.processedAt).toBeNull();
    expect(transaction.providerId).toBe('provider-a');
    expect(transaction.isTerminal()).toBe(false);
  });

  it('restores reference linkage and failure code as persisted', () => {
    const transaction = WagerTransaction.rehydrate(
      persistedProps({
        kind: WagerTransactionKind.REFUND,
        referenceExternalTransactionId: 'bet-789',
        referenceTransactionId: 'reference-internal-9',
        status: WagerTransactionStatus.REJECTED,
        failureCode: FailureCode.REFERENCE_MISMATCH,
        processedAt: later,
      }),
    );

    expect(transaction.referenceExternalTransactionId).toBe('bet-789');
    expect(transaction.referenceTransactionId).toBe('reference-internal-9');
    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
    expect(transaction.processedAt).toEqual(later);
  });
});

describe('WagerTransaction enums', () => {
  it('keeps the kind vocabulary aligned with the migration check', () => {
    expect(Object.values(WagerTransactionKind)).toEqual([
      'OPENING',
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK',
    ]);
  });

  it('keeps the status vocabulary aligned with the migration check', () => {
    expect(Object.values(WagerTransactionStatus)).toEqual([
      'PENDING',
      'PENDING_REFERENCE',
      'PROCESSED',
      'REJECTED',
      'FAILED',
    ]);
  });

  it('keeps the failure code vocabulary stable (README §7.2)', () => {
    // Dois códigos entraram com as regras 4 e 5 das reversões (§7): a
    // taxonomia é nossa, mas fica estável e documentada.
    expect(Object.values(FailureCode)).toEqual([
      'INSUFFICIENT_FUNDS',
      'INSUFFICIENT_BALANCE_FOR_REVERSAL',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_MISMATCH',
      'REFERENCE_AMOUNT_MISMATCH',
      'REFERENCE_ALREADY_REVERSED',
      'INTERNAL_ERROR',
    ]);
  });
});
