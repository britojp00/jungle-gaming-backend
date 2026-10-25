import { describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
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
import { OutboxMessageEntity } from '../../../infrastructure/persistence/entities/outbox-message.entity.js';
import {
  ProcessBetInput,
  ProcessBetUseCase,
} from './process-bet.use-case.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';

function seededWalletRow(balance: string) {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
  };
}

function betInput() {
  return {
    walletId: WALLET_ID,
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    amount: '25.00',
    currency: 'BRL',
    // Obrigatórios pelo README 6.3/§9 — ver `ProcessBetInput`.
    roundId: 'round-987',
    gameId: 'fortune-chimp',
  };
}

describe('ProcessBetUseCase — contrato WalletBalanceChanged', () => {
  it('emits WalletBalanceChanged matching the README contract when the balance changes', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    const result = await useCase.execute(betInput());

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });

    // A direção do evento precisa refletir o lançamento real do ledger.
    const entries = fake.rows<WalletLedgerEntryEntity>(
      WalletLedgerEntryEntity,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.DEBIT);

    const event = fake
      .rows<OutboxMessageEntity>(OutboxMessageEntity)
      .find((candidate) => candidate.eventType === 'WalletBalanceChanged');

    expect(event).toBeDefined();

    // Contrato README 11 — WalletBalanceChangedData, sem campos extras.
    expect(event!.payload.data).toEqual({
      walletId: WALLET_ID,
      transactionId: result.transactionId,
      direction: LedgerDirection.DEBIT,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('does not emit WalletBalanceChanged when the bet is rejected for insufficient funds', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('10.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    const result = await useCase.execute(betInput());

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');

    // Sem mudança de saldo: nenhum lançamento e nenhum evento de saldo.
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);

    const events = fake.rows<OutboxMessageEntity>(OutboxMessageEntity);
    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  it('keeps the event monetary values as exact decimal strings', async () => {
    const fake = new FakeEntityManager();
    // 1e16 supera o limite de precisão segura de `number` (2^53 ≈ 9.007e15):
    // como double perderia os dígitos finais, o valor precisa viajar como string.
    fake.seed(WalletEntity, seededWalletRow('10000000000000000.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    await useCase.execute({
      ...betInput(),
      amount: '1234567890123.45',
    });

    const event = fake
      .rows<OutboxMessageEntity>(OutboxMessageEntity)
      .find((candidate) => candidate.eventType === 'WalletBalanceChanged');

    const data = event!.payload.data as Record<string, unknown>;
    const moneyProps = data.money as Record<string, unknown>;
    const balanceAfter = data.balanceAfter as Record<string, unknown>;

    expect(typeof moneyProps.amount).toBe('string');
    expect(moneyProps.amount).toBe('1234567890123.45');
    expect(typeof balanceAfter.amount).toBe('string');
    expect(balanceAfter.amount).toBe('9998765432109876.55');
  });
});

describe('ProcessBetUseCase — integração com o domínio WagerTransaction', () => {
  it('constrói a BET pela factory de domínio e persiste roundId e gameId', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    const result = await useCase.execute(betInput());

    const rows = fake.rows<WagerTransactionEntity>(WagerTransactionEntity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(WagerTransactionKind.BET);
    expect(rows[0]!.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(rows[0]!.roundId).toBe('round-987');
    expect(rows[0]!.gameId).toBe('fortune-chimp');
    expect(rows[0]!.rejectionReason).toBeNull();
    expect(rows[0]!.processedAt).toBeInstanceOf(Date);
    expect(rows[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.referenceExternalTransactionId).toBeNull();
    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.replayed).toBe(false);
  });

  it('rejeita BET sem roundId (ausente ou em branco) como payload inválido', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    // Ausente: simula um chamador fora do contrato TypeScript (ex.: HTTP/SQS).
    const withoutRoundId = { ...betInput() };
    delete (withoutRoundId as Partial<ProcessBetInput>).roundId;

    await expect(
      useCase.execute(withoutRoundId as ProcessBetInput),
    ).rejects.toThrow('INVALID_ROUNDID');
    await expect(
      useCase.execute({ ...betInput(), roundId: '' }),
    ).rejects.toThrow('INVALID_ROUNDID');
    await expect(
      useCase.execute({ ...betInput(), roundId: '   ' }),
    ).rejects.toThrow('INVALID_ROUNDID');

    // Payload inválido não toca o banco: nem transação, nem ledger, nem outbox.
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('rejeita BET sem gameId (ausente ou em branco) como payload inválido', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    const withoutGameId = { ...betInput() };
    delete (withoutGameId as Partial<ProcessBetInput>).gameId;

    await expect(
      useCase.execute(withoutGameId as ProcessBetInput),
    ).rejects.toThrow('INVALID_GAMEID');
    await expect(
      useCase.execute({ ...betInput(), gameId: '' }),
    ).rejects.toThrow('INVALID_GAMEID');
    await expect(
      useCase.execute({ ...betInput(), gameId: '   ' }),
    ).rejects.toThrow('INVALID_GAMEID');

    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('aplica as validações da factory createBet antes de tocar o banco', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    // providerId com 101 caracteres passa pela validação da aplicação (só
    // checa presença) e é recusado pelo limite de coluna da factory — prova
    // de que o caminho de domínio está de fato no fluxo.
    await expect(
      useCase.execute({ ...betInput(), providerId: 'p'.repeat(101) }),
    ).rejects.toThrow('Provider ID must be at most 100 characters');

    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
  });

  it('registra saldo insuficiente com o FailureCode centralizado', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('10.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    const result = await useCase.execute(betInput());

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    const row = fake.rows<WagerTransactionEntity>(WagerTransactionEntity)[0]!;
    // Representação persistida compatível com a coluna `rejection_reason`.
    expect(row.rejectionReason).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(row.rejectionReason).toBe('INSUFFICIENT_FUNDS');
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    // `reject(code)` não recebe data (README 6.3): nada foi aplicado.
    expect(row.processedAt).toBeNull();
    expect(row.resultBalanceAmount).toBe('10.00');

    // Regra 6: REJECTED não movimenta saldo nem gera lançamento.
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('10.00');

    const rejectedEvent = fake
      .rows<OutboxMessageEntity>(OutboxMessageEntity)
      .find((event) => event.eventType === 'WagerTransactionRejected');

    const data = rejectedEvent!.payload.data as Record<string, unknown>;
    expect(data.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
  });

  it('replay idempotente devolve o resultado original sem novos efeitos', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    const input = betInput();
    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(first.status);
    expect(second.balance).toEqual(first.balance);
    expect(second.walletVersion).toBe(first.walletVersion);

    // Um único registro, um único débito, eventos não duplicados.
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(1);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);

    const eventTypes = fake
      .rows<OutboxMessageEntity>(OutboxMessageEntity)
      .map((event) => event.eventType);
    expect(eventTypes.filter((type) => type === 'WagerTransactionProcessed')).toHaveLength(1);
    expect(eventTypes.filter((type) => type === 'WalletBalanceChanged')).toHaveLength(1);
  });

  it('mesma chave com payload diferente gera conflito, não replay (README §9)', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessBetUseCase(fake.asEntityManager());

    await useCase.execute(betInput());

    // Mesma `(providerId, idempotencyKey)`, conteúdo diferente.
    await expect(
      useCase.execute({ ...betInput(), amount: '30.00' }),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');

    // O conflito não produziu efeito algum.
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(1);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('75.00');
  });
});
