import { describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';

import { InvalidEnvelopeError } from '../application/messaging/wager-transaction-requested.js';
import { httpError } from './http-errors.js';

/**
 * Contrato de status do README §9: payload inválido (400), conflito de
 * idempotência (409), não encontrado (404) e falha transitória de
 * infraestrutura (503) — distinguindo o que o provedor deve corrigir do que
 * ele pode reenviar, sem expor mensagens internas do banco.
 */
describe('httpError — erros permanentes não são transitórios', () => {
  it('CURRENCY_MISMATCH é payload inválido (400), não 503', () => {
    const mapped = httpError(new Error('CURRENCY_MISMATCH'));

    expect(mapped.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('WALLET_PLAYER_MISMATCH é payload inválido (400), não 503', () => {
    const mapped = httpError(new Error('WALLET_PLAYER_MISMATCH'));

    expect(mapped.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('valor fora de numeric(20,2) é payload inválido (400)', () => {
    const mapped = httpError(
      new Error('Monetary amount exceeds numeric(20,2)'),
    );

    expect(mapped.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });
});

describe('httpError — mensagens internas do banco não são expostas', () => {
  it('violação de unique vira 409 com código estável', () => {
    const raw = new UniqueConstraintViolationException(
      new Error(
        'insert into "wager_transactions" ... violates unique constraint "wager_transactions_external_unique"',
      ),
    );

    const mapped = httpError(raw);

    expect(mapped.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(mapped.getResponse()).toEqual({
      message: 'UNIQUE_CONSTRAINT_VIOLATION',
    });
  });

  it('erro de infraestrutura vira 503 com código estável, sem a mensagem crua', () => {
    const mapped = httpError(
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    );

    expect(mapped.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(mapped.getResponse()).toEqual({ message: 'INTERNAL_ERROR' });
  });
});

describe('httpError — mapeamento existente preservado', () => {
  it('não encontrado continua 404', () => {
    expect(httpError(new Error('WALLET_NOT_FOUND')).getStatus()).toBe(
      HttpStatus.NOT_FOUND,
    );
    expect(httpError(new Error('TRANSACTION_NOT_FOUND')).getStatus()).toBe(
      HttpStatus.NOT_FOUND,
    );
  });

  it('conflitos de idempotência/reversão continuam 409', () => {
    for (const message of [
      'WALLET_ALREADY_EXISTS',
      'IDEMPOTENCY_PAYLOAD_CONFLICT',
      'REFERENCE_ALREADY_REVERSED',
    ]) {
      const mapped = httpError(new Error(message));
      expect(mapped.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(mapped.getResponse()).toEqual({ message });
    }
  });

  it('payload inválido continua 400', () => {
    const mapped = httpError(new InvalidEnvelopeError('kind is required'));

    expect(mapped.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });
});
