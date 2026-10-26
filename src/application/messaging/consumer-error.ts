import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';

import { InvalidEnvelopeError } from './wager-transaction-requested.js';

/**
 * Classificação de erro do consumidor (README §10): erros de **negócio**
 * (terminal, ack), **transitórios** (retry com backoff) e **permanentes**
 * (DLQ).
 *
 * A taxonomia é do projeto (§7.2: "a taxonomia é sua — defina-a e
 * documente-a"). O que está decidido aqui:
 *
 * - **negócio** não vira exceção: o caso de uso financeiro RETORNA o
 *   resultado — inclusive `REJECTED` — com a transação persistida, e o
 *   consumidor confirma a mensagem (ack);
 * - **permanente** é o que nunca vai funcionar em outra entrega: envelope ou
 *   payload inválido (`InvalidEnvelopeError` e as validações de `isInvalidPayloadConsumerError`),
 *   divergência de identidade da wallet e o conflito de idempotência
 *   (`IDEMPOTENCY_PAYLOAD_CONFLICT` — §9: "mesma key com payload diferente →
 *   conflito, e não replay");
 * - **transitório** é todo o resto (banco ou SQS indisponível, estado que
 *   outra tentativa pode ver diferente): nada é confirmado e o redelivery do
 *   SQS assume, com o `maxReceiveCount` levando à DLQ quando o limite vence.
 */

/** Código estável lançado pelos casos de uso ao detectar payload divergente. */
export const IDEMPOTENCY_PAYLOAD_CONFLICT = 'IDEMPOTENCY_PAYLOAD_CONFLICT';

/** Nome da constraint única da Inbox (migration inicial). */
export const INBOX_CONSUMER_MESSAGE_UNIQUE = 'inbox_consumer_message_unique';

/**
 * Payload permanentemente inválido: nenhuma reentrega vai aceitá-lo (§10:
 * "permanentes (DLQ)" — retentar é inútil). Cobrem-se o envelope
 * (`InvalidEnvelopeError`), os códigos estáveis `INVALID_*`, as validações do
 * domínio ("nunca vai passar") e as divergências de identidade da wallet
 * (`WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`): a wallet não muda de
 * player nem de moeda, então o erro não se corrige esperando.
 */
export function isInvalidPayloadConsumerError(error: unknown): boolean {
  if (error instanceof InvalidEnvelopeError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;

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
    message.includes('cannot be negative') ||
    message.includes('exceeds numeric') ||
    message.includes('Idempotency-Key')
  );
}

export function isPermanentConsumerError(error: unknown): boolean {
  if (isInvalidPayloadConsumerError(error)) {
    return true;
  }

  return (
    error instanceof Error &&
    (error.message === IDEMPOTENCY_PAYLOAD_CONFLICT ||
      error.message === 'REFERENCE_ALREADY_REVERSED')
  );
}

/**
 * A violação da única `(consumer_name, message_id)` significa que OUTRO
 * consumidor já registrou e confirmou esta mensagem — o índice único só
 * acusa depois de a transação concorrente confirmar. Nesse caso não há o que
 * repetir: a mensagem é confirmada.
 *
 * Os casos de uso financeiros já tratam a própria unique de idempotência
 * (`resolveConcurrentDuplicate`) e devolvem resultado; o que escapa daqui
 * com o nome da constraint da Inbox é exatamente esta corrida.
 */
export function isInboxDuplicate(error: unknown): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    String(error.message).includes(INBOX_CONSUMER_MESSAGE_UNIQUE)
  );
}
