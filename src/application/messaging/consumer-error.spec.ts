import { describe, expect, it } from 'vitest';

import { InvalidEnvelopeError } from './wager-transaction-requested.js';
import {
  isPermanentConsumerError,
  IDEMPOTENCY_PAYLOAD_CONFLICT,
} from './consumer-error.js';

/**
 * Classificação do consumidor (README §10): o que nunca vai funcionar em
 * outra entrega é permanente (DLQ imediata) — reentregas inúteis de mensagem
 * inválida só gastam tentativas até o `maxReceiveCount`.
 */
describe('isPermanentConsumerError — permanente (DLQ)', () => {
  it.each([
    ['envelope inválido', new InvalidEnvelopeError('kind is required')],
    ['código INVALID_*', new Error('INVALID_WALLETID')],
    ['valor fora da faixa', new Error('Monetary amount exceeds numeric(20,2)')],
    ['valor inválido do domínio', new Error('Invalid monetary amount')],
    ['valor não positivo', new Error('WIN amount must be positive')],
    ['campo obrigatório', new Error('Player ID is required')],
    ['referência proibida no kind', new Error('BET does not support a reference')],
    ['conflito de idempotência', new Error(IDEMPOTENCY_PAYLOAD_CONFLICT)],
    ['reversão já aplicada', new Error('REFERENCE_ALREADY_REVERSED')],
    ['player divergente da wallet', new Error('WALLET_PLAYER_MISMATCH')],
    ['moeda divergente da wallet', new Error('CURRENCY_MISMATCH')],
  ])('%s', (_label, error) => {
    expect(isPermanentConsumerError(error)).toBe(true);
  });
});

describe('isPermanentConsumerError — transitório (reentrega)', () => {
  it.each([
    ['wallet ainda não existe', new Error('WALLET_NOT_FOUND')],
    ['banco indisponível', new Error('connect ECONNREFUSED 127.0.0.1:5432')],
    ['violação de unique tratável', new Error('unique constraint violation')],
  ])('%s', (_label, error) => {
    expect(isPermanentConsumerError(error)).toBe(false);
  });

  it('erro não-Error segue transitório', () => {
    expect(isPermanentConsumerError('SQS fora do ar')).toBe(false);
    expect(isPermanentConsumerError(undefined)).toBe(false);
  });
});
