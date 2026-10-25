import { EntityManager } from '@mikro-orm/postgresql';

import {
  OutboxMessageRepository,
  OutboxClaim,
} from '../../../infrastructure/persistence/repositories/outbox-message.repository.js';
import {
  REFERENCE_RETRY_MAX_ATTEMPTS,
  referenceRetryDelayMs,
} from '../../wagering/reference-retry-policy.js';
import {
  OutboxPublisher,
  OutboxPublishing,
} from '../outbox-publisher.js';

/** Mensagens por ciclo: suficiente para drenar uma fila normal. */
export const DEFAULT_OUTBOX_CLAIM_LIMIT = 20;

export interface PublishOutboxMessagesOptions {
  limit?: number;
  /**
   * Relógio do ciclo. Toda janela e todo carimbo de publicação usam ESTE
   * instante — nunca `Date.now()` escondido — para que os testes sejam
   * determinísticos.
   */
  now?: Date;
}

export interface OutboxPublishProblem {
  reason: 'PUBLISH_FAILED';
  messageId: string;
  eventType: string;
  /** Mensagem do erro do transporte — nunca o payload financeiro. */
  detail: string;
}

export interface PublishOutboxMessagesResult {
  /** Mensagens reivindicadas nesta tentativa (tentativa já contada). */
  claimed: number;
  published: number;
  failed: number;
  problems: OutboxPublishProblem[];
}

/**
 * Worker de publicação da outbox (README §11).
 *
 * "A persistência da transação, a alteração de saldo, o lançamento no ledger
 * (…) e o evento de integração precisam ser atômicos" — isso já vale no
 * COMMIT: o evento nasce na mesma transação dos efeitos. Este caso de uso
 * cobre o que vem depois — **publicar** o que ficou confirmado — com
 * múltiplos publishers concorrentes, "sem perder nem duplicar
 * indefinidamente".
 *
 * Ciclo (mesmo mecanismo já adotado pelo worker da §7.1):
 *
 * 1. **claim** numa transação curta: `SELECT … WHERE status = 'PENDING' AND
 *    next_attempt_at <= now … LIMIT n FOR UPDATE SKIP LOCKED`, com a tentativa
 *    contada e a próxima janela gravada ANTES de soltar a linha;
 * 2. **publicação fora da transação** do banco — o SQS é externo e não
 *    participa do commit;
 * 3. `PUBLISHED` + `published_at` por mensagem, ou só `last_error` quando a
 *    publicação falha (tentativa e janela já estão gravadas).
 *
 * Por que nada se perde: uma queda **entre o claim e a publicação** deixa a
 * mensagem `PENDING` com a janela já gravada — ela volta a ser elegível
 * sozinha, sem lock órfão e sem estado `PROCESSING` para recuperar. O que o
 * `SKIP LOCKED` garante é que **dois publishers não levam a mesma mensagem ao
 * mesmo tempo**. Um reenvio do mesmo evento (queda entre publicar e marcar)
 * pode, porém, chegar ao consumidor: a deduplicação FIFO do SQS
 * (`MessageDeduplicationId` = id do evento) é só **proteção adicional** e
 * vale dentro da janela do broker — o README (§8) é explícito em que recursos
 * de ordenação e deduplicação do broker são otimização, não a garantia final.
 * Tornar uma duplicata segura é tarefa do **consumidor**, com a Inbox
 * persistente por `(consumerName, messageId)` que a §10 exige (fora desta
 * etapa).
 *
 * Retentativas **limitadas**: cada tentativa é contada no próprio claim e a
 * espera cresce com o backoff já adotado (5 s × 2^(n−1), teto 15 min);
 * esgotadas as `REFERENCE_RETRY_MAX_ATTEMPTS`, a mensagem continua na outbox
 * — auditável, não reivindicada, **sem** ganhar estado novo nem semântica de
 * fila morta.
 */
export class PublishOutboxMessagesUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly publisher: OutboxPublisher,
  ) {}

  async execute(
    options: PublishOutboxMessagesOptions = {},
  ): Promise<PublishOutboxMessagesResult> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? DEFAULT_OUTBOX_CLAIM_LIMIT;

    const claimed = await this.claim(limit, now);

    const result: PublishOutboxMessagesResult = {
      claimed: claimed.length,
      published: 0,
      failed: 0,
      problems: [],
    };

    for (const message of claimed) {
      const publishing: OutboxPublishing = {
        messageId: message.id,
        aggregateId: message.aggregateId,
        payload: message.payload,
      };

      try {
        await this.publisher.publish(publishing);
        await this.markPublished(message.id, now);
        result.published += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        // Tentativa e próxima janela já foram gravadas no claim: a mensagem
        // volta a ser elegível sozinha. Só se registra o motivo — nunca o
        // payload financeiro (README §12).
        await this.recordFailure(message.id, detail);

        result.failed += 1;
        result.problems.push({
          reason: 'PUBLISH_FAILED',
          messageId: message.id,
          eventType: message.eventType,
          detail,
        });
      }
    }

    return result;
  }

  private async claim(limit: number, now: Date): Promise<OutboxClaim[]> {
    return this.em.transactional(async (txEm) => {
      const repository = new OutboxMessageRepository(txEm);
      const messages = await repository.claimPublishable(
        limit,
        REFERENCE_RETRY_MAX_ATTEMPTS,
        now,
      );

      for (const message of messages) {
        const attempts = message.attempts + 1;

        await repository.recordAttempt(
          message.id,
          attempts,
          new Date(now.getTime() + referenceRetryDelayMs(attempts)),
        );
      }

      return messages;
    });
  }

  private async markPublished(id: string, at: Date): Promise<void> {
    await this.em.transactional(async (txEm) => {
      await new OutboxMessageRepository(txEm).markPublished(id, at);
    });
  }

  private async recordFailure(id: string, detail: string): Promise<void> {
    await this.em.transactional(async (txEm) => {
      await new OutboxMessageRepository(txEm).recordFailure(id, detail);
    });
  }
}
