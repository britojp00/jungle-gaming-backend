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
import { REFERENCE_RETRY_MAX_ATTEMPTS, REFERENCE_TTL_MS } from '../reference-retry-policy.js';
import { ResolvePendingReferencesUseCase } from './resolve-pending-references.use-case.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_WALLET_ID = '44444444-4444-4444-8444-444444444444';
const WIN_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_ID = '55555555-5555-4555-8555-555555555555';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-24T11:55:00.000Z');

function referenceTo(walletId: string) {
  return { __reference: true, entityClass: WalletEntity, id: walletId };
}

function seededWalletRow(balance: string, id = WALLET_ID) {
  return {
    id,
    playerId: 'player-1',
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
  };
}

/** Linha `PENDING_REFERENCE` já gravada pela entrada (WIN com referência). */
function seededPendingWin(overrides: Record<string, unknown> = {}) {
  return {
    id: WIN_ID,
    wallet: referenceTo(WALLET_ID),
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'win-100',
    idempotencyKey: 'provider-a:win-100',
    payloadHash: 'a'.repeat(64),
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.WIN,
    status: WagerTransactionStatus.PENDING_REFERENCE,
    amount: '25.00',
    currency: 'BRL',
    referenceExternalTransactionId: 'bet-777',
    referenceTransaction: null,
    rejectionReason: null,
    processedAt: null,
    // O que a entrada gravou ao aceitar a WIN: saldo observado ANTES do
    // crédito (§7, regra 7) — o worker é quem o atualiza ao concluir.
    resultBalanceAmount: '100.00',
    resultBalanceCurrency: 'BRL',
    resultWalletVersion: 1,
    referenceAttempts: 0,
    referenceNextAttemptAt: new Date('2026-10-24T11:59:00.000Z'),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** Linha do claim, com os MESMOS nomes de coluna do banco. */
function claimRowFor(
  row: { id: string; createdAt: Date },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: row.id,
    wallet_id: WALLET_ID,
    reference_attempts: 0,
    created_at: row.createdAt,
    ...overrides,
  };
}

/** BET `PROCESSED` da mesma rodada — o que torna a referência resolvível. */
function seededResolvedTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    wallet: referenceTo(WALLET_ID),
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'bet-777',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.BET,
    status: WagerTransactionStatus.PROCESSED,
    amount: '10.00',
    currency: 'BRL',
    ...overrides,
  };
}

/** O evento original do aceite — o worker não o reemite. */
function seededOriginalPendingEvent() {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    eventType: 'WagerTransactionPendingReference',
    aggregateId: WIN_ID,
    status: 'PENDING',
    attempts: 0,
    payload: { version: 1, data: { status: 'PENDING_REFERENCE' } },
    occurredAt: CREATED_AT,
    createdAt: CREATED_AT,
  };
}

function eventTypes(fake: FakeEntityManager): string[] {
  return fake
    .rows<OutboxMessageEntity>(OutboxMessageEntity)
    .map((event) => event.eventType);
}

function findEvent(fake: FakeEntityManager, eventType: string) {
  return fake
    .rows<OutboxMessageEntity>(OutboxMessageEntity)
    .find((event) => event.eventType === eventType);
}

function winRow(fake: FakeEntityManager): WagerTransactionEntity {
  const row = fake
    .rows<WagerTransactionEntity>(WagerTransactionEntity)
    .find((candidate) => candidate.id === WIN_ID);

  expect(row).toBeDefined();

  return row!;
}

describe('ResolvePendingReferencesUseCase — claim e agendamento', () => {
  it('seleciona com FOR UPDATE SKIP LOCKED, conta a tentativa e agenda a próxima janela', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin());
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ claimed: 1, stillPending: 1, rejected: 0 });

    // A consulta é a de §7.1, com as duas condições da elegibilidade.
    expect(fake.executed).toHaveLength(1);
    expect(fake.executed[0]!.sql).toMatch(/for update skip locked/i);
    expect(fake.executed[0]!.sql).toMatch(
      /status = 'PENDING_REFERENCE'[\s\S]*reference_next_attempt_at <= \?/i,
    );
    expect(fake.executed[0]!.params).toEqual([NOW, 20]);

    // Tentativa contada e janela futura gravadas ANTES de liberar a linha.
    expect(winRow(fake).referenceAttempts).toBe(1);
    expect(winRow(fake).referenceNextAttemptAt).toEqual(
      new Date(NOW.getTime() + 5_000),
    );
  });

  it('não faz nada quando não há linha elegível', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.claimRows = [];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toEqual({
      claimed: 0,
      resolved: 0,
      rejected: 0,
      inconsistent: 0,
      stillPending: 0,
      skipped: 0,
      problems: [],
    });
    expect(eventTypes(fake)).toEqual([]);
  });

  it('agenda a tentativa vencida no prazo absoluto, sem esperar o backoff', async () => {
    const fake = new FakeEntityManager();
    const createdAt = new Date(NOW.getTime() - REFERENCE_TTL_MS - 1_000);

    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin({ createdAt }));
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    await useCase.execute({ now: NOW });

    // `min(now + backoff, created_at + TTL)` — a janela cai no passado.
    expect(winRow(fake).referenceNextAttemptAt).toEqual(
      new Date(createdAt.getTime() + REFERENCE_TTL_MS),
    );
    expect(winRow(fake).referenceNextAttemptAt.getTime()).toBeLessThan(
      NOW.getTime(),
    );
  });
});

describe('ResolvePendingReferencesUseCase — referência ainda ausente', () => {
  it('permanece pendente sem reemitir o evento nem alterar saldo', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin());
    fake.seed(OutboxMessageEntity, seededOriginalPendingEvent());
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({
      claimed: 1,
      stillPending: 1,
      rejected: 0,
      resolved: 0,
      problems: [],
    });

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(row.rejectionReason).toBeNull();
    expect(row.referenceTransaction).toBeNull();
    expect(row.resultBalanceAmount).toBe('100.00'); // saldo pré-crédito

    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');

    // O evento do aceite continua sendo o único: nada de reemitir a cada
    // tentativa (o publisher futuro publicará este).
    expect(eventTypes(fake)).toEqual(['WagerTransactionPendingReference']);
  });

  it('rejeita com REFERENCE_NOT_FOUND quando esgotam as tentativas', async () => {
    const fake = new FakeEntityManager();
    const attempts = REFERENCE_RETRY_MAX_ATTEMPTS - 1; // claim faz virar 10

    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin({ referenceAttempts: attempts }));
    fake.claimRows = [
      claimRowFor({ id: WIN_ID, createdAt: CREATED_AT }, { reference_attempts: attempts }),
    ];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ claimed: 1, rejected: 1, stillPending: 0 });

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejectionReason).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(row.processedAt).toBeNull();

    const event = findEvent(fake, 'WagerTransactionRejected');
    expect(event?.payload.data).toMatchObject({
      transactionId: WIN_ID,
      status: WagerTransactionStatus.REJECTED,
      failureCode: FailureCode.REFERENCE_NOT_FOUND,
    });

    // Rejeição sem efeito financeiro (§7, regra 6).
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.version).toBe(1);
  });

  it('rejeita com REFERENCE_NOT_FOUND quando vence o TTL, mesmo com tentativas sobrando', async () => {
    const fake = new FakeEntityManager();
    const createdAt = new Date(NOW.getTime() - REFERENCE_TTL_MS);

    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin({ createdAt }));
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ rejected: 1, problems: [] });

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejectionReason).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(findEvent(fake, 'WagerTransactionRejected')).toBeDefined();
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
  });
});

describe('ResolvePendingReferencesUseCase — referência resolvida (regra 2)', () => {
  it('credita, grava a FK e atualiza o saldo observado da linha', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin());
    fake.seed(WagerTransactionEntity, seededResolvedTarget());
    fake.seed(OutboxMessageEntity, seededOriginalPendingEvent());
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ resolved: 1, rejected: 0, problems: [] });

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(row.referenceTransaction).toEqual(
      expect.objectContaining({ id: TARGET_ID }),
    );
    expect(row.processedAt).toBeInstanceOf(Date);

    // §7, regra 7: o replay precisa devolver o saldo OBSERVADO AO CONCLUIR,
    // não o saldo pré-crédito que a linha carregava ao nascer pendente.
    expect(row.resultBalanceAmount).toBe('125.00');
    expect(row.resultWalletVersion).toBe(2);

    const wallet = fake.rows<WalletEntity>(WalletEntity)[0]!;
    expect(wallet.balance).toBe('125.00');
    expect(wallet.version).toBe(2);

    const entries = fake.rows<WalletLedgerEntryEntity>(WalletLedgerEntryEntity);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.CREDIT);
    expect(entries[0]!.amount).toBe('25.00');
    expect(entries[0]!.balanceBefore).toBe('100.00');
    expect(entries[0]!.balanceAfter).toBe('125.00');

    expect(eventTypes(fake)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    expect(findEvent(fake, 'WalletBalanceChanged')?.payload.data).toMatchObject({
      walletId: WALLET_ID,
      transactionId: WIN_ID,
      balanceAfter: { amount: '125.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('rejeita com REFERENCE_MISMATCH quando a referência viola um vínculo', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin());
    fake.seed(
      WagerTransactionEntity,
      seededResolvedTarget({ roundId: 'round-000' }),
    );
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ rejected: 1, resolved: 0 });

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejectionReason).toBe(FailureCode.REFERENCE_MISMATCH);

    expect(findEvent(fake, 'WagerTransactionRejected')?.payload.data).toMatchObject({
      failureCode: FailureCode.REFERENCE_MISMATCH,
    });
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
  });
});

describe('ResolvePendingReferencesUseCase — corrida, anomalia e falha', () => {
  it('pula linhas já concluídas por outra instância entre o claim e o lock', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(
      WagerTransactionEntity,
      seededPendingWin({
        status: WagerTransactionStatus.PROCESSED,
        referenceAttempts: 3,
      }),
    );
    fake.claimRows = [
      claimRowFor(
        { id: WIN_ID, createdAt: CREATED_AT },
        { reference_attempts: 3 },
      ),
    ];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ claimed: 1, skipped: 1, resolved: 0 });
    expect(result.problems).toEqual([]);
    expect(eventTypes(fake)).toEqual([]);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
  });

  it('trata PENDING_REFERENCE sem referência como inconsistência, não como referência inexistente', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(
      WagerTransactionEntity,
      seededPendingWin({ referenceExternalTransactionId: null }),
    );
    fake.seed(OutboxMessageEntity, seededOriginalPendingEvent());
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ inconsistent: 1, rejected: 0 });

    // Estado terminal AUDITÁVEL e distinto da rejeição de §7.1.
    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.FAILED);
    expect(row.rejectionReason).toBe(FailureCode.INTERNAL_ERROR);
    expect(row.rejectionReason).not.toBe(FailureCode.REFERENCE_NOT_FOUND);

    // Log estruturado: sem payload financeiro, com o campo faltante.
    expect(result.problems).toEqual([
      {
        reason: 'UNRESOLVABLE_STATE',
        transactionId: WIN_ID,
        walletId: WALLET_ID,
        missing: 'reference_external_transaction_id',
      },
    ]);

    // §11 não prevê evento para falha de infraestrutura.
    expect(eventTypes(fake)).toEqual(['WagerTransactionPendingReference']);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
  });

  it('falha em uma linha não impede as demais do lote', async () => {
    const fake = new FakeEntityManager();
    const brokenWalletId = MISSING_WALLET_ID;
    const otherWinId = '77777777-7777-4777-8777-777777777777';

    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin());
    fake.seed(
      WagerTransactionEntity,
      seededPendingWin({
        id: otherWinId,
        externalTransactionId: 'win-101',
        idempotencyKey: 'provider-a:win-101',
      }),
    );
    fake.seed(WagerTransactionEntity, seededResolvedTarget());
    fake.claimRows = [
      // wallet inexistente → WALLET_NOT_FOUND, capturado por linha.
      {
        id: WIN_ID,
        wallet_id: brokenWalletId,
        reference_attempts: 0,
        created_at: CREATED_AT,
      },
      {
        id: otherWinId,
        wallet_id: WALLET_ID,
        reference_attempts: 0,
        created_at: CREATED_AT,
      },
    ];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result.claimed).toBe(2);
    expect(result.problems).toEqual([
      {
        reason: 'PROCESSING_FAILED',
        transactionId: WIN_ID,
        walletId: brokenWalletId,
        detail: 'WALLET_NOT_FOUND',
      },
    ]);

    // A segunda linha concluiu normalmente.
    expect(result.resolved).toBe(1);
    expect(winRow(fake).status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    const other = fake
      .rows<WagerTransactionEntity>(WagerTransactionEntity)
      .find((row) => row.id === otherWinId)!;
    expect(other.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);
  });
});

describe('ResolvePendingReferencesUseCase — auto-referência (regra 2)', () => {
  /**
   * `externalTransactionId === referenceExternalTransactionId`: não há
   * OUTRA transação que resolva a referência — e como `(provider_id,
   * external_transaction_id)` é único, nunca haverá. É referência AUSENTE
   * (§7, regra 8), que a §7.1 reprocessa e termina com
   * `REFERENCE_NOT_FOUND`; nunca um crédito para a própria linha.
   */
  function selfReferencingWin(overrides: Record<string, unknown> = {}) {
    return seededPendingWin({
      externalTransactionId: 'win-self',
      referenceExternalTransactionId: 'win-self',
      ...overrides,
    });
  }

  it('não resolve a própria transação como referência: segue pendente, sem crédito', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, selfReferencingWin());
    fake.seed(OutboxMessageEntity, seededOriginalPendingEvent());
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({
      claimed: 1,
      resolved: 0,
      rejected: 0,
      inconsistent: 0,
      stillPending: 1,
    });

    // Nada de saldo, ledger nem evento novo (§7, regra 6 e §11): se a
    // referência apontasse para a própria linha, haveria um crédito sem BET.
    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(row.referenceTransaction).toBeNull();
    expect(row.resultBalanceAmount).toBe('100.00');
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(eventTypes(fake)).toEqual(['WagerTransactionPendingReference']);
  });

  it('a auto-referência termina pela §7.1: REJECTED + REFERENCE_NOT_FOUND no limite', async () => {
    const fake = new FakeEntityManager();
    const attempts = REFERENCE_RETRY_MAX_ATTEMPTS;

    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, selfReferencingWin());
    fake.claimRows = [
      claimRowFor(
        { id: WIN_ID, createdAt: CREATED_AT },
        { reference_attempts: attempts },
      ),
    ];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({
      claimed: 1,
      rejected: 1,
      resolved: 0,
      problems: [],
    });

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.REJECTED);
    expect(row.rejectionReason).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(row.referenceTransaction).toBeNull();
    expect(findEvent(fake, 'WagerTransactionRejected')).toBeDefined();
    expect(findEvent(fake, 'WalletBalanceChanged')).toBeUndefined();
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
  });
});

describe('ResolvePendingReferencesUseCase — vínculo wallet ↔ transação', () => {
  /**
   * `wallets.player_id` e a moeda da wallet não mudam depois da abertura e
   * são conferidos na entrada da WIN: uma linha persistida que os contradiz
   * é erro permanente de infraestrutura (§6.3 → `FAILED`), não algo que se
   * resolva esperando. Antes da correção, esses casos eram engolidos pelo
   * `catch` por linha e reivindicados a cada janela para sempre.
   */
  it('termina como FAILED + INTERNAL_ERROR quando o player diverge da wallet', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin({ playerId: 'player-2' }));
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({
      claimed: 1,
      inconsistent: 1,
      resolved: 0,
      rejected: 0,
    });
    expect(result.problems).toEqual([
      {
        reason: 'UNRESOLVABLE_STATE',
        transactionId: WIN_ID,
        walletId: WALLET_ID,
        missing: 'player_id',
      },
    ]);

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.FAILED);
    expect(row.rejectionReason).toBe(FailureCode.INTERNAL_ERROR);
    expect(row.referenceTransaction).toBeNull();
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(eventTypes(fake)).toEqual([]);

    // Estado TERMINAL (§6.3): o ciclo seguinte pula a linha em vez de
    // reivindicá-la de novo — é isso que encerra o retry infinito.
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];
    const second = await useCase.execute({ now: NOW });

    expect(second).toMatchObject({
      claimed: 1,
      skipped: 1,
      inconsistent: 0,
      stillPending: 0,
    });
    expect(second.problems).toEqual([]);
  });

  it('termina como FAILED + INTERNAL_ERROR quando a moeda diverge da wallet', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededPendingWin({ currency: 'USD' }));
    fake.claimRows = [claimRowFor({ id: WIN_ID, createdAt: CREATED_AT })];

    const useCase = new ResolvePendingReferencesUseCase(fake.asEntityManager());
    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ claimed: 1, inconsistent: 1, rejected: 0 });
    expect(result.problems).toEqual([
      {
        reason: 'UNRESOLVABLE_STATE',
        transactionId: WIN_ID,
        walletId: WALLET_ID,
        missing: 'currency',
      },
    ]);

    const row = winRow(fake);
    expect(row.status).toBe(WagerTransactionStatus.FAILED);
    expect(row.rejectionReason).toBe(FailureCode.INTERNAL_ERROR);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(eventTypes(fake)).toEqual([]);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
  });
});
