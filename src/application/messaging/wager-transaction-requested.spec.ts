import { describe, expect, it } from 'vitest';

import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';
import {
  InvalidEnvelopeError,
  parseWagerTransactionRequested,
} from './wager-transaction-requested.js';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
    ...overrides,
  };
}

function withData(overrides: Record<string, unknown>) {
  return envelope({
    data: { ...(envelope()['data'] as Record<string, unknown>), ...overrides },
  });
}

describe('parseWagerTransactionRequested — envelope oficial (§10)', () => {
  it('aceita o envelope documentado e normaliza occurredAt', () => {
    const parsed = parseWagerTransactionRequested(envelope());

    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.type).toBe('WagerTransactionRequested');
    expect(parsed.occurredAt).toEqual(new Date('2026-07-29T15:00:00.000Z'));
    expect(parsed.data).toMatchObject({
      providerId: 'provider-a',
      kind: WagerTransactionKind.BET,
      money: { amount: '25.00', currency: 'BRL' },
    });
  });

  it('aceita a referência opcional de WIN (§7, regras 1 e 2)', () => {
    const parsed = parseWagerTransactionRequested(
      withData({
        kind: 'WIN',
        referenceExternalTransactionId: 'transaction-123',
      }),
    );

    expect(parsed.data.referenceExternalTransactionId).toBe(
      'transaction-123',
    );
  });
});

describe('parseWagerTransactionRequested — erro permanente (DLQ)', () => {
  it('recusa corpo que não é objeto nem o tipo esperado', () => {
    expect(() => parseWagerTransactionRequested('texto')).toThrow(
      InvalidEnvelopeError,
    );
    expect(() => parseWagerTransactionRequested(null)).toThrow(
      'Message body must be an object',
    );
    expect(() =>
      parseWagerTransactionRequested(envelope({ type: 'OutroEvento' })),
    ).toThrow('Unknown message type: OutroEvento');
  });

  it('recusa identidade e data inválidas', () => {
    expect(() =>
      parseWagerTransactionRequested(envelope({ messageId: '' })),
    ).toThrow('messageId is required');
    expect(() =>
      parseWagerTransactionRequested(envelope({ occurredAt: 'ontem' })),
    ).toThrow('occurredAt must be a valid ISO-8601 date');
  });

  it('recusa data ausente ou com campos de negócio faltando', () => {
    expect(() =>
      parseWagerTransactionRequested(envelope({ data: null })),
    ).toThrow('data must be an object');
    expect(() =>
      parseWagerTransactionRequested(withData({ providerId: '  ' })),
    ).toThrow('INVALID_PROVIDERID');
    expect(() =>
      parseWagerTransactionRequested(withData({ walletId: undefined })),
    ).toThrow('INVALID_WALLETID');
  });

  it('recusa kind desconhecido e aplica a política de referência por kind', () => {
    expect(() =>
      parseWagerTransactionRequested(withData({ kind: 'OPENING' })),
    ).toThrow('Unsupported kind: OPENING');

    // Regra 1: REFUND/ROLLBACK exigem referência.
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect(() =>
        parseWagerTransactionRequested(withData({ kind })),
      ).toThrow('Reference external transaction ID is required');
    }

    // BET/LOSS não aceitam referência.
    expect(() =>
      parseWagerTransactionRequested(
        withData({ kind: 'LOSS', referenceExternalTransactionId: 'bet-1' }),
      ),
    ).toThrow('LOSS does not support a reference');
  });

  it('recusa dinheiro inválido como parte do envelope', () => {
    expect(() =>
      parseWagerTransactionRequested(withData({ money: null })),
    ).toThrow('money must be an object');
    expect(() =>
      parseWagerTransactionRequested(
        withData({ money: { amount: 'vinte', currency: 'BRL' } }),
      ),
    ).toThrow(InvalidEnvelopeError);
    expect(() =>
      parseWagerTransactionRequested(
        withData({ money: { amount: '25.00', currency: 'REAL' } }),
      ),
    ).toThrow(InvalidEnvelopeError);
    expect(() =>
      parseWagerTransactionRequested(
        withData({ money: { amount: '25.000', currency: 'BRL' } }),
      ),
    ).toThrow(InvalidEnvelopeError);
  });

  it('recusa referência inválida e BET com referência (§7)', () => {
    expect(() =>
      parseWagerTransactionRequested(
        withData({ referenceExternalTransactionId: '  ' }),
      ),
    ).toThrow('referenceExternalTransactionId must be a non-empty string');
    expect(() =>
      parseWagerTransactionRequested(
        withData({ kind: 'BET', referenceExternalTransactionId: 'transaction-1' }),
      ),
    ).toThrow('BET does not support a reference');
  });
});
