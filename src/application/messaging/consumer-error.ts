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
 * - **permanente** é o que nunca vai funcionar em outra entrega: envelope
 *   inválido (`InvalidEnvelopeError`) e o conflito de idempotência
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

export function isPermanentConsumerError(error: unknown): boolean {
  if (error instanceof InvalidEnvelopeError) {
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
