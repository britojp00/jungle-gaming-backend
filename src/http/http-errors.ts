import {
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';

import { InvalidEnvelopeError } from '../application/messaging/wager-transaction-requested.js';

/**
 * Mapeamento de erro do README §9: a API precisa distinguir, **de forma
 * consistente em todos os endpoints**, payload inválido (400), conflito de
 * idempotência (409), rejeição por regra de negócio (422), aceite com
 * processamento pendente (202) e falha transitória de infraestrutura (503).
 * Não encontrado (404) completa o conjunto.
 */
export function httpError(error: unknown): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (
    message === 'WALLET_NOT_FOUND' ||
    message === 'TRANSACTION_NOT_FOUND'
  ) {
    return new HttpException({ message }, HttpStatus.NOT_FOUND);
  }

  if (
    message === 'WALLET_ALREADY_EXISTS' ||
    message === 'IDEMPOTENCY_PAYLOAD_CONFLICT' ||
    message === 'REFERENCE_ALREADY_REVERSED' ||
    error instanceof UniqueConstraintViolationException
  ) {
    // A mensagem crua do banco (constraint, SQL) nunca vai para o cliente:
    // quem viola a unique recebe o código estável, o diagnóstico fica no log
    // do servidor (README §12).
    return new HttpException(
      {
        message:
          error instanceof UniqueConstraintViolationException
            ? 'UNIQUE_CONSTRAINT_VIOLATION'
            : message,
      },
      HttpStatus.CONFLICT,
    );
  }

  if (error instanceof InvalidEnvelopeError || isInvalidPayload(message)) {
    return new HttpException({ message }, HttpStatus.BAD_REQUEST);
  }

  // Qualquer outra coisa é infraestrutura (banco/SQS fora, timeout…):
  // transitória, e portanto 503 — nunca 500 silencioso. Mensagens internas
  // (driver, SQL, stack) não são expostas: código estável para o provedor
  // decidir reenviar, diagnóstico no log do servidor (README §12).
  return new HttpException(
    { message: 'INTERNAL_ERROR' },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/**
 * Erros de validação de payload/domínio — o conteúdo nunca vai passar, nem
 * com reentrega (o provedor deve corrigir o payload). Inclui os códigos
 * estáveis de divergência de identidade: `WALLET_PLAYER_MISMATCH` e
 * `CURRENCY_MISMATCH` não se corrigem esperando (a wallet não muda de player
 * nem de moeda), logo não são falha transitória.
 */
function isInvalidPayload(message: string): boolean {
  return (
    message.startsWith('INVALID_') ||
    message.startsWith('Invalid') ||
    message === 'WALLET_PLAYER_MISMATCH' ||
    message === 'CURRENCY_MISMATCH' ||
    message.includes('is required') ||
    message.includes('must be') ||
    message.includes('does not support') ||
    message.includes('Unsupported kind') ||
    message.includes('Unknown message type') ||
    message.includes('Currency mismatch') ||
    message.includes('Insufficient') ||
    message.includes('cannot be negative') ||
    message.includes('exceeds numeric') ||
    message.includes('Idempotency-Key')
  );
}
