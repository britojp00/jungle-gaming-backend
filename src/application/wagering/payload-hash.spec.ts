import { describe, expect, it } from 'vitest';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';
import { hashWagerPayload, type WagerPayload } from './payload-hash.js';

const base: WagerPayload = {
  kind: WagerTransactionKind.BET,
  walletId: 'wallet-1',
  playerId: 'player-1',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  amount: '25.00',
  currency: 'BRL',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  referenceExternalTransactionId: null,
};

describe('hashWagerPayload', () => {
  it('returns a 64-character lowercase hex digest', () => {
    expect(hashWagerPayload(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same business payload', () => {
    expect(hashWagerPayload(base)).toBe(hashWagerPayload({ ...base }));
  });

  it('ignores key insertion order (canonical JSON, README §9)', () => {
    const reordered: WagerPayload = {
      currency: base.currency,
      gameId: base.gameId,
      roundId: base.roundId,
      kind: base.kind,
      providerId: base.providerId,
      playerId: base.playerId,
      walletId: base.walletId,
      externalTransactionId: base.externalTransactionId,
      amount: base.amount,
      referenceExternalTransactionId: base.referenceExternalTransactionId,
    };

    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(base));
  });

  it('normalizes an undefined value to null before hashing', () => {
    // Simula um chamador fora do contrato TypeScript (ex.: JS externo):
    // `undefined` e `null` representam a mesma ausência de dado.
    const withUndefined = {
      ...base,
      roundId: undefined,
      gameId: undefined,
      referenceExternalTransactionId: undefined,
    } as unknown as WagerPayload;

    const withNulls: WagerPayload = {
      ...base,
      roundId: null,
      gameId: null,
      referenceExternalTransactionId: null,
    };

    expect(hashWagerPayload(withUndefined)).toBe(
      hashWagerPayload(withNulls),
    );
  });

  it('produces a different hash for a different kind (README §9: mesma chave com payload diferente é conflito)', () => {
    const asRefund: WagerPayload = {
      ...base,
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: 'bet-789',
    };

    expect(hashWagerPayload(asRefund)).not.toBe(hashWagerPayload(base));
  });

  it('produces a different hash when only the kind changes', () => {
    const asWin: WagerPayload = { ...base, kind: WagerTransactionKind.WIN };

    expect(hashWagerPayload(asWin)).not.toBe(hashWagerPayload(base));
  });

  it('produces a different hash for a different monetary value', () => {
    expect(hashWagerPayload({ ...base, amount: '25.01' })).not.toBe(
      hashWagerPayload(base),
    );
  });

  it('produces a different hash for a different reference', () => {
    const refundOne: WagerPayload = {
      ...base,
      kind: WagerTransactionKind.ROLLBACK,
      referenceExternalTransactionId: 'bet-789',
    };
    const refundTwo: WagerPayload = {
      ...refundOne,
      referenceExternalTransactionId: 'bet-990',
    };

    expect(hashWagerPayload(refundOne)).not.toBe(hashWagerPayload(refundTwo));
  });

  it('excludes transport metadata from the payload contract (README §9: o header não entra no hash)', () => {
    const withHeader: WagerPayload = {
      ...base,
      // @ts-expect-error — Idempotency-Key não é campo de negócio; a
      // assinatura impede que o header ou metadados de transporte entrem.
      idempotencyKey: 'provider-a:transaction-123',
    };

    expect(hashWagerPayload(withHeader)).toMatch(/^[0-9a-f]{64}$/);
  });
});
