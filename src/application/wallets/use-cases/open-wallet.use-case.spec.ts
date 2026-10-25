import { describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import { Money } from '../../../domain/shared/value-objects/money.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import {
  LedgerDirection,
  WalletLedgerEntryEntity,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from '../../../infrastructure/persistence/entities/outbox-message.entity.js';
import { OpenWalletUseCase } from './open-wallet.use-case.js';

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function seededWalletRow(playerId = 'player-1') {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    playerId,
    currency: 'BRL',
    balance: '50.00',
    version: 1,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
  };
}

describe('OpenWalletUseCase', () => {
  it('creates wallet, OPENING transaction, ledger entry and outbox event for a positive balance', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    const result = await useCase.execute({
      playerId: 'player-1',
      initialBalance: money('1000.00'),
    });

    expect(result.playerId).toBe('player-1');
    expect(result.balance).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
    expect(result.version).toBe(1);

    const wallets = fake.rows<WalletEntity>(WalletEntity);
    const transactions = fake.rows<WagerTransactionEntity>(
      WagerTransactionEntity,
    );
    const entries = fake.rows<WalletLedgerEntryEntity>(
      WalletLedgerEntryEntity,
    );
    const events = fake.rows<OutboxMessageEntity>(OutboxMessageEntity);

    expect(wallets).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(events).toHaveLength(1);

    const wallet = wallets[0]!;
    expect(wallet.id).toBe(result.id);
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance).toBe('1000.00');
    expect(wallet.version).toBe(1);

    const opening = transactions[0]!;
    expect(opening.id).not.toBe(wallet.id);
    expect(opening.wallet).toEqual(
      fake.getReference(WalletEntity, wallet.id),
    );
    expect(opening.playerId).toBe('player-1');
    expect(opening.kind).toBe(WagerTransactionKind.OPENING);
    expect(opening.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(opening.amount).toBe('1000.00');
    expect(opening.currency).toBe('BRL');
    expect(opening.processedAt).toBeInstanceOf(Date);
    expect(opening.resultBalanceAmount).toBe('1000.00');
    expect(opening.resultBalanceCurrency).toBe('BRL');
    expect(opening.resultWalletVersion).toBe(1);

    const entry = entries[0]!;
    expect(entry.wallet).toEqual(
      fake.getReference(WalletEntity, wallet.id),
    );
    expect(entry.transaction).toEqual(
      fake.getReference(WagerTransactionEntity, opening.id),
    );
    expect(entry.direction).toBe(LedgerDirection.CREDIT);
    expect(entry.amount).toBe('1000.00');
    expect(entry.balanceBefore).toBe('0.00');
    expect(entry.balanceAfter).toBe('1000.00');
    expect(entry.currency).toBe('BRL');

    const event = events[0]!;
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.status).toBe(OutboxMessageStatus.PENDING);
    expect(event.aggregateId).toBe(wallet.id);
    expect(event.attempts).toBe(0);
    expect(event.occurredAt).toBeInstanceOf(Date);

    // Contrato README 11 — WalletBalanceChangedData, sem campos extras.
    expect(event.payload.data).toEqual({
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.CREDIT,
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('creates only the wallet when the initial balance is zero', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    const result = await useCase.execute({
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
    });

    expect(result.balance).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(result.version).toBe(1);
    expect(fake.rows(WalletEntity)).toHaveLength(1);
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('keeps monetary values as exact decimal strings, never as numbers', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    // 18 dígitos inteiros: como number perderia precisão.
    const hugeAmount = '123456789012345678.99';

    const result = await useCase.execute({
      playerId: 'player-1',
      initialBalance: money(hugeAmount),
    });

    expect(typeof result.balance.amount).toBe('string');
    expect(result.balance.amount).toBe(hugeAmount);

    const wallet = fake.rows<WalletEntity>(WalletEntity)[0]!;
    expect(typeof wallet.balance).toBe('string');
    expect(wallet.balance).toBe(hugeAmount);

    const opening = fake.rows<WagerTransactionEntity>(
      WagerTransactionEntity,
    )[0]!;
    expect(opening.amount).toBe(hugeAmount);
    expect(opening.resultBalanceAmount).toBe(hugeAmount);

    const entry = fake.rows<WalletLedgerEntryEntity>(
      WalletLedgerEntryEntity,
    )[0]!;
    expect(typeof entry.amount).toBe('string');
    expect(entry.balanceAfter).toBe(hugeAmount);

    const data = fake.rows<OutboxMessageEntity>(
      OutboxMessageEntity,
    )[0]!.payload.data as Record<string, unknown>;
    const moneyProps = data.money as Record<string, unknown>;
    const balanceAfter = data.balanceAfter as Record<string, unknown>;
    expect(typeof moneyProps.amount).toBe('string');
    expect(moneyProps.amount).toBe(hugeAmount);
    expect(typeof balanceAfter.amount).toBe('string');
    expect(balanceAfter.amount).toBe(hugeAmount);
  });

  it('starts at version 1 and keeps the ledger consistent with the balance', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    const result = await useCase.execute({
      playerId: 'player-1',
      initialBalance: money('250.75'),
    });

    expect(result.version).toBe(1);

    const wallet = fake.rows<WalletEntity>(WalletEntity)[0]!;
    const entry = fake.rows<WalletLedgerEntryEntity>(
      WalletLedgerEntryEntity,
    )[0]!;

    // balanceBefore + amount === balanceAfter, sem passar por float.
    const before = money(entry.balanceBefore);
    const amount = money(entry.amount);
    const after = money(entry.balanceAfter);

    expect(before.add(amount).toJSON()).toEqual(after.toJSON());
    expect(after.toJSON().amount).toBe(wallet.balance);
    expect(result.balance.amount).toBe(wallet.balance);
  });

  it('rejects a wallet that already exists for the same player and currency', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow());
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    await expect(
      useCase.execute({
        playerId: 'player-1',
        initialBalance: money('10.00'),
      }),
    ).rejects.toThrow('WALLET_ALREADY_EXISTS');

    expect(fake.rows(WalletEntity)).toHaveLength(1);
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('maps a unique constraint violation to a conflict, rolling back its own records', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    // Corrida: a pré-checagem não enxerga a wallet, que é confirmada por
    // outra transação antes do nosso flush.
    fake.beforeFlush = () => {
      fake.seed(WalletEntity, seededWalletRow());
    };

    await expect(
      useCase.execute({
        playerId: 'player-1',
        initialBalance: money('10.00'),
      }),
    ).rejects.toThrow('WALLET_ALREADY_EXISTS');

    // Sobrevive apenas a wallet da transação concorrente; a nossa
    // operação inteira foi revertida.
    expect(fake.rows(WalletEntity)).toHaveLength(1);
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('rolls back every record when the operation fails', async () => {
    const fake = new FakeEntityManager();
    fake.failOnFlush = true;
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    await expect(
      useCase.execute({
        playerId: 'player-1',
        initialBalance: money('1000.00'),
      }),
    ).rejects.toThrow('SIMULATED_FLUSH_FAILURE');

    expect(fake.rows(WalletEntity)).toHaveLength(0);
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('does not create provider or idempotency metadata for the opening', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    await useCase.execute({
      playerId: 'player-1',
      initialBalance: money('100.00'),
    });

    const opening = fake.rows<WagerTransactionEntity>(
      WagerTransactionEntity,
    )[0]!;

    expect(opening.providerId).toBeNull();
    expect(opening.externalTransactionId).toBeNull();
    expect(opening.idempotencyKey).toBeNull();
    expect(opening.payloadHash).toBeNull();
    expect(opening.roundId).toBeNull();
    expect(opening.gameId).toBeNull();
    expect(opening.referenceExternalTransactionId).toBeNull();
    expect(opening.referenceTransaction).toBeNull();
    expect(opening.rejectionReason).toBeNull();
  });

  it('rejects an empty playerId', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    await expect(
      useCase.execute({
        playerId: '   ',
        initialBalance: money('10.00'),
      }),
    ).rejects.toThrow('INVALID_PLAYER_ID');

    expect(fake.rows(WalletEntity)).toHaveLength(0);
  });

  it('rejects an initial balance that is not a Money', async () => {
    const fake = new FakeEntityManager();
    const useCase = new OpenWalletUseCase(fake.asEntityManager());

    await expect(
      useCase.execute({
        playerId: 'player-1',
        initialBalance: 10 as unknown as Money,
      }),
    ).rejects.toThrow('INVALID_INITIAL_BALANCE');

    expect(fake.rows(WalletEntity)).toHaveLength(0);
  });
});
