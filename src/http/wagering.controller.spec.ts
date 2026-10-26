import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

import { FakeEntityManager } from '../../test/support/fake-entity-manager.js';
import { WalletEntity } from '../infrastructure/persistence/entities/wallet.entity.js';
import { WageringController } from './wagering.controller.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';

function seededWalletRow() {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    updatedAt: new Date('2026-10-25T10:00:00.000Z'),
  };
}

const winBody = {
  providerId: 'provider-a',
  externalTransactionId: 'win-100',
  playerId: 'player-1',
  walletId: WALLET_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'WIN',
  money: { amount: '25.00', currency: 'BRL' },
};

/**
 * Log estruturado do processamento HTTP (README §12): os identificadores do
 * fluxo em uma linha JSON, sem payload financeiro.
 */
describe('WageringController — log estruturado do processamento HTTP (§12)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra correlationId, messageId, transactionId, walletId e providerId', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow());
    const controller = new WageringController(fake.asEntityManager());

    const result = await controller.submit(
      { status: () => undefined } as unknown as Response,
      'provider-a:win-100',
      winBody,
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(logSpy.mock.calls[0]![0])) as Record<
      string,
      unknown
    >;

    expect(line).toMatchObject({
      event: 'transaction_submitted',
      // O mesmo `correlationId` gravado nos eventos da outbox da transação.
      correlationId: result['transactionId'],
      messageId: 'provider-a:win-100',
      transactionId: result['transactionId'],
      walletId: WALLET_ID,
      providerId: 'provider-a',
      kind: 'WIN',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
  });

  it('não registra valores financeiros', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow());
    const controller = new WageringController(fake.asEntityManager());

    await controller.submit(
      { status: () => undefined } as unknown as Response,
      'provider-a:win-100',
      winBody,
    );

    const line = String(logSpy.mock.calls[0]![0]);

    // §12: identificadores e resultado, nunca o payload financeiro.
    expect(line).not.toContain('25.00');
    expect(line).not.toContain('100.00');
    expect(line).not.toContain('balance');
    expect(line).not.toContain('money');
  });
});
