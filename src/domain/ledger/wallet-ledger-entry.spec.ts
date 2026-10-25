import { describe, expect, it } from 'vitest';
import { Money } from '../shared/value-objects/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

const date = new Date('2026-10-24T12:00:00.000Z');

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function creditProps() {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.CREDIT,
    money: money('1000.00'),
    balanceBefore: Money.zero('BRL'),
    balanceAfter: money('1000.00'),
    createdAt: date,
  };
}

function debitProps() {
  return {
    id: 'entry-2',
    walletId: 'wallet-1',
    transactionId: 'transaction-2',
    direction: LedgerDirection.DEBIT,
    money: money('80.00'),
    balanceBefore: money('100.00'),
    balanceAfter: money('20.00'),
    createdAt: date,
  };
}

describe('WalletLedgerEntry.create', () => {
  it('creates a credit entry when the arithmetic is consistent', () => {
    const entry = WalletLedgerEntry.create(creditProps());

    expect(entry.id).toBe('entry-1');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.direction).toBe(LedgerDirection.CREDIT);
    expect(entry.money.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
    expect(entry.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('1000.00');
    expect(entry.createdAt).toEqual(date);
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a debit entry when the arithmetic is consistent', () => {
    const entry = WalletLedgerEntry.create(debitProps());

    expect(entry.direction).toBe(LedgerDirection.DEBIT);
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows debiting the exact balance down to zero', () => {
    const entry = WalletLedgerEntry.create({
      ...debitProps(),
      money: money('100.00'),
      balanceAfter: Money.zero('BRL'),
    });

    expect(entry.balanceAfter.isZero()).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  it('defaults createdAt to the current time when omitted', () => {
    const props = creditProps();
    const entry = WalletLedgerEntry.create({
      ...props,
      createdAt: undefined,
    });

    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.createdAt.getTime()).not.toBeNaN();
  });

  it('rejects a missing entry, wallet or transaction id', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...creditProps(), id: '' }),
    ).toThrow('Ledger entry ID is required');

    expect(() =>
      WalletLedgerEntry.create({ ...creditProps(), id: '   ' }),
    ).toThrow('Ledger entry ID is required');

    expect(() =>
      WalletLedgerEntry.create({ ...creditProps(), walletId: '' }),
    ).toThrow('Wallet ID is required');

    expect(() =>
      WalletLedgerEntry.create({ ...creditProps(), transactionId: '' }),
    ).toThrow('Transaction ID is required');
  });

  it('rejects a direction outside the ledger vocabulary', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        direction: 'SIDEWAYS' as unknown as LedgerDirection,
      }),
    ).toThrow('Invalid ledger direction');
  });

  it('rejects a zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        money: Money.zero('BRL'),
        balanceAfter: Money.zero('BRL'),
      }),
    ).toThrow('Ledger amount must be positive');
  });

  it('rejects a negative amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        money: money('10.00').negate(),
      }),
    ).toThrow('Ledger amount must be positive');
  });

  it('rejects negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        balanceBefore: money('100.00').negate(),
      }),
    ).toThrow('Ledger balances cannot be negative');

    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        balanceAfter: money('20.00').negate(),
      }),
    ).toThrow('Ledger balances cannot be negative');
  });

  it('rejects a debit that would drive the balance negative', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        balanceBefore: money('10.00'),
        balanceAfter: money('20.00'),
      }),
    ).toThrow('Ledger entry is not balanced');
  });

  it('rejects amounts and balances in different currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        money: money('1000.00', 'USD'),
      }),
    ).toThrow('Currency mismatch');

    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        balanceAfter: money('1000.00', 'USD'),
      }),
    ).toThrow('Currency mismatch');
  });

  it('rejects a credit whose resulting balance is wrong', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        balanceAfter: money('1100.00'),
      }),
    ).toThrow('Ledger entry is not balanced');

    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        balanceAfter: Money.zero('BRL'),
      }),
    ).toThrow('Ledger entry is not balanced');
  });

  it('rejects a debit recorded with credit arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...debitProps(),
        direction: LedgerDirection.CREDIT,
      }),
    ).toThrow('Ledger entry is not balanced');
  });

  it('rejects a credit recorded with debit arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        direction: LedgerDirection.DEBIT,
      }),
    ).toThrow('Ledger entry is not balanced');
  });

  it('rejects an invalid creation date', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...creditProps(),
        createdAt: new Date(Number.NaN),
      }),
    ).toThrow('Invalid date');
  });
});

describe('WalletLedgerEntry rehydration', () => {
  it('reconstructs a persisted entry as-is', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...creditProps(),
    });

    expect(entry.id).toBe('entry-1');
    expect(entry.direction).toBe(LedgerDirection.CREDIT);
    expect(entry.createdAt).toEqual(date);
    expect(entry.isBalanced()).toBe(true);
  });

  it('rehydrates persisted state without revalidating', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...creditProps(),
      balanceAfter: money('999.00'),
    });

    expect(entry.balanceAfter.toJSON().amount).toBe('999.00');
    expect(entry.isBalanced()).toBe(false);
  });

  it('reports cross-currency persisted data as unbalanced', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...creditProps(),
      balanceAfter: money('1000.00', 'USD'),
    });

    expect(entry.isBalanced()).toBe(false);
  });
});

describe('WalletLedgerEntry immutability', () => {
  it('exposes no transition methods', () => {
    const methods = Object.getOwnPropertyNames(
      WalletLedgerEntry.prototype,
    ).filter((name) => name !== 'constructor');

    expect(methods).toEqual(['isBalanced']);
  });
});
