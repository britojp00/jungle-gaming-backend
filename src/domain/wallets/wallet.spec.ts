
import { describe, expect, it } from 'vitest';
import { Money } from '../shared/value-objects/money.js';
import { Wallet } from './wallet.js';

const date = new Date('2026-10-23T12:00:00.000Z');

function createWallet(initialBalance = '100.00') {
  return Wallet.create({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({
      amount: initialBalance,
      currency: 'BRL',
    }),
    createdAt: date,
  });
}

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

describe('Wallet', () => {
  it('creates a wallet with version 1', () => {
    const wallet = createWallet();

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(date);
    expect(wallet.updatedAt).toEqual(date);
  });

  it('allows creating a wallet with zero balance', () => {
    const wallet = createWallet('0.00');

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.create({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('10.00').negate(),
        createdAt: date,
      }),
    ).toThrow('Initial balance cannot be negative');
  });

  it('credits the balance and increments the version', () => {
    const wallet = createWallet();

    wallet.credit(money('25.50'), new Date('2026-10-23T13:00:00.000Z'));

    expect(wallet.balance.toJSON().amount).toBe('125.50');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(
      '2026-10-23T13:00:00.000Z',
    );
  });

  it('debits the balance and increments the version', () => {
    const wallet = createWallet();

    wallet.debit(money('30.00'), new Date('2026-10-23T13:00:00.000Z'));

    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  it('allows debiting the exact available balance', () => {
    const wallet = createWallet();

    wallet.debit(money('100.00'), date);

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  it('rejects insufficient balance without changing state', () => {
    const wallet = createWallet();

    expect(() => wallet.debit(money('100.01'), date)).toThrow(
      'Insufficient wallet balance',
    );

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(date);
  });

  it('rejects zero and negative movement amounts', () => {
    const wallet = createWallet();

    expect(() => wallet.credit(money('0.00'), date)).toThrow(
      'Amount must be positive',
    );

    expect(() => wallet.debit(money('0.00'), date)).toThrow(
      'Amount must be positive',
    );

    expect(() => wallet.credit(money('5.00').negate(), date)).toThrow(
      'Amount must be positive',
    );

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects movements in a different currency', () => {
    const wallet = createWallet();

    expect(() => wallet.credit(money('10.00', 'USD'), date)).toThrow(
      'Currency mismatch',
    );

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects invalid dates without changing state', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.credit(money('10.00'), new Date(Number.NaN)),
    ).toThrow('Invalid date');

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rehydrates a persisted wallet without applying a movement', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: money('75.00'),
      version: 4,
      createdAt: date,
      updatedAt: new Date('2026-10-23T14:00:00.000Z'),
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(4);
    expect(wallet.updatedAt.toISOString()).toBe(
      '2026-10-23T14:00:00.000Z',
    );
  });
});
