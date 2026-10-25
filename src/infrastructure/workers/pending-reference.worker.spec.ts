import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { FakeEntityManager } from '../../../test/support/fake-entity-manager.js';
import { WalletEntity } from '../persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../persistence/entities/wager-transaction.entity.js';
import {
  DEFAULT_PENDING_REFERENCE_POLL_MS,
  MIN_PENDING_REFERENCE_POLL_MS,
  PendingReferenceWorker,
  PENDING_REFERENCE_ENABLED_ENV,
  PENDING_REFERENCE_POLL_MS_ENV,
  resolvePendingReferencePollMs,
} from './pending-reference.worker.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const WIN_ID = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-24T11:55:00.000Z');

function seededWalletRow() {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function seededPendingWin(overrides: Record<string, unknown> = {}) {
  return {
    id: WIN_ID,
    wallet: { __reference: true, entityClass: WalletEntity, id: WALLET_ID },
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
    resultBalanceAmount: '100.00',
    resultBalanceCurrency: 'BRL',
    resultWalletVersion: 1,
    referenceAttempts: 0,
    referenceNextAttemptAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function claimRowFor(overrides: Record<string, unknown> = {}) {
  return {
    id: WIN_ID,
    wallet_id: WALLET_ID,
    reference_attempts: 0,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function workerWith(fake: FakeEntityManager): PendingReferenceWorker {
  return new PendingReferenceWorker(fake.asEntityManager());
}

describe('resolvePendingReferencePollMs — configuração', () => {
  it('usa o padrão quando a variável não existe ou é inválida', () => {
    expect(resolvePendingReferencePollMs({})).toBe(
      DEFAULT_PENDING_REFERENCE_POLL_MS,
    );
    expect(
      resolvePendingReferencePollMs({
        [PENDING_REFERENCE_POLL_MS_ENV]: 'abc',
      }),
    ).toBe(DEFAULT_PENDING_REFERENCE_POLL_MS);
    expect(
      resolvePendingReferencePollMs({ [PENDING_REFERENCE_POLL_MS_ENV]: '0' }),
    ).toBe(DEFAULT_PENDING_REFERENCE_POLL_MS);
    expect(
      resolvePendingReferencePollMs({ [PENDING_REFERENCE_POLL_MS_ENV]: '-1000' }),
    ).toBe(DEFAULT_PENDING_REFERENCE_POLL_MS);
    expect(
      resolvePendingReferencePollMs({
        [PENDING_REFERENCE_POLL_MS_ENV]: String(MIN_PENDING_REFERENCE_POLL_MS - 1),
      }),
    ).toBe(DEFAULT_PENDING_REFERENCE_POLL_MS);
  });

  it('aceita um intervalo válido', () => {
    expect(
      resolvePendingReferencePollMs({ [PENDING_REFERENCE_POLL_MS_ENV]: '250' }),
    ).toBe(250);
    expect(
      resolvePendingReferencePollMs({
        [PENDING_REFERENCE_POLL_MS_ENV]: String(MIN_PENDING_REFERENCE_POLL_MS),
      }),
    ).toBe(MIN_PENDING_REFERENCE_POLL_MS);
  });
});

describe('PendingReferenceWorker — ciclo', () => {
  let errorSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delega ao caso de uso e registra o resumo do ciclo', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow());
    fake.claimRows = [claimRowFor()]; // a linha não existe → skipped

    const worker = workerWith(fake);
    const result = await worker.tick(NOW);

    expect(result).toMatchObject({
      claimed: 1,
      skipped: 1,
      resolved: 0,
      problems: [],
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]![0])).toContain(
      '"claimed":1,"resolved":0',
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('não registra nada quando o claim volta vazio', async () => {
    const fake = new FakeEntityManager();
    fake.claimRows = [];

    const worker = workerWith(fake);
    const result = await worker.tick(NOW);

    expect(result).toMatchObject({ claimed: 0 });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('registra a inconsistência de estado como log estruturado, sem payload financeiro', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow());
    fake.seed(
      WagerTransactionEntity,
      seededPendingWin({ referenceExternalTransactionId: null }),
    );
    fake.claimRows = [claimRowFor()];

    const worker = workerWith(fake);
    const result = await worker.tick(NOW);

    expect(result).toMatchObject({ inconsistent: 1 });
    expect(result?.problems).toEqual([
      expect.objectContaining({
        reason: 'UNRESOLVABLE_STATE',
        missing: 'reference_external_transaction_id',
      }),
    ]);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]![0]);
    expect(line).toContain(
      'estado inconsistente em linha PENDING_REFERENCE',
    );

    const payload = JSON.parse(line.slice(line.indexOf('{'))) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      reason: 'UNRESOLVABLE_STATE',
      transactionId: WIN_ID,
      walletId: WALLET_ID,
      missing: 'reference_external_transaction_id',
    });

    // Nenhum valor monetário no log (AGENTS.md).
    expect(line).not.toContain('25.00');
    expect(line).not.toContain('100.00');
  });

  it('registra falha de processamento com o motivo', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow());
    fake.claimRows = [
      claimRowFor({ wallet_id: '44444444-4444-4444-8444-444444444444' }),
    ];

    const worker = workerWith(fake);
    const result = await worker.tick(NOW);

    expect(result?.problems).toEqual([
      expect.objectContaining({
        reason: 'PROCESSING_FAILED',
        detail: 'WALLET_NOT_FOUND',
      }),
    ]);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(
      'falha ao reprocessar linha PENDING_REFERENCE',
    );
  });

  it('falha do claim vira null, sem derrubar o agendador', async () => {
    const fake = new FakeEntityManager();
    fake.failOnExecute = true;

    const worker = workerWith(fake);
    const result = await worker.tick(NOW);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain(
      'ciclo do worker de referências falhou',
    );
  });

  it('não sobrepõe ciclos: enquanto um roda, o seguinte é pulado', async () => {
    const fake = new FakeEntityManager();
    fake.failOnExecute = true;

    const worker = workerWith(fake);

    const first = worker.tick(NOW);
    const second = await worker.tick(NOW);

    expect(second).toBeNull();
    await expect(first).resolves.toBeNull();
  });
});

describe('PendingReferenceWorker — agendamento', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env[PENDING_REFERENCE_POLL_MS_ENV];
    delete process.env[PENDING_REFERENCE_ENABLED_ENV];
  });

  it('agenda no intervalo configurado e para no desligamento', () => {
    process.env[PENDING_REFERENCE_POLL_MS_ENV] = '250';
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const fake = new FakeEntityManager();
    const worker = workerWith(fake);
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.onModuleInit();
    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(750);
    expect(tick).toHaveBeenCalledTimes(4);

    worker.onModuleDestroy();
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('usa o padrão quando a configuração é inválida', () => {
    process.env[PENDING_REFERENCE_POLL_MS_ENV] = 'nope';
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.onModuleInit();
    vi.advanceTimersByTime(DEFAULT_PENDING_REFERENCE_POLL_MS);

    expect(tick).toHaveBeenCalledTimes(1);
    worker.onModuleDestroy();
  });

  it('não agenda quando desabilitado por variável de ambiente', () => {
    process.env[PENDING_REFERENCE_ENABLED_ENV] = 'false';
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.onModuleInit();
    vi.advanceTimersByTime(DEFAULT_PENDING_REFERENCE_POLL_MS * 5);

    expect(tick).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('desabilitado');
  });

  it('start é idempotente e stop sem efeito quando nada agenda', () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.stop(); // nada a limpar
    worker.start();
    worker.start();

    vi.advanceTimersByTime(DEFAULT_PENDING_REFERENCE_POLL_MS);
    expect(tick).toHaveBeenCalledTimes(1);

    worker.onModuleDestroy();
    worker.onModuleDestroy();
  });
});
