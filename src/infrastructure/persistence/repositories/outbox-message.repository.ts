import { EntityManager } from '@mikro-orm/postgresql';

import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from '../entities/outbox-message.entity.js';

/**
 * Uma mensagem `PENDING` reivindicada para publicação (README §11).
 * Os campos vêm em colunas — a seleção acontece ANTES de qualquer efeito e a
 * linha ainda pode ser levada por outro publisher.
 */
export interface OutboxClaim {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * `jsonb` lido por SQL cru pode voltar como objeto (parser do driver) ou como
 * string literal, dependendo do caminho. Normaliza para o objeto que será
 * publicado — é o MESMO payload gravado pelo caso de uso, sem reescrita.
 */
function toPayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value as Record<string, unknown>;
}

export class OutboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Seleção das mensagens elegíveis à publicação (README §11 e §6.5
   * `isDue(now)`).
   *
   * - `status = 'PENDING'` + `next_attempt_at <= now` — a janela gravada na
   *   própria transação do claim (como no worker da §7.1) é o que impede que
   *   dois publishers levem a MESMA mensagem: quem chega depois pula a linha
   *   (`FOR UPDATE SKIP LOCKED`) ou a encontra fora da janela;
   * - `attempts < limite` — retentativas limitadas: esgotadas, a mensagem
   *   continua na tabela (não se perde, não ganha estado novo) e deixa de ser
   *   selecionada;
   * - `order by next_attempt_at, created_at` é o mesmo caminho do índice
   *   `outbox_status_next_attempt_idx`.
   */
  async claimPublishable(
    limit: number,
    maxAttempts: number,
    now: Date,
  ): Promise<OutboxClaim[]> {
    const rows = await this.em.execute(
      `select id, event_type, aggregate_id, payload, attempts
         from outbox_messages
        where status = 'PENDING'
          and next_attempt_at <= ?
          and attempts < ?
        order by next_attempt_at, created_at
        limit ?
        for update skip locked`,
      [now, maxAttempts, limit],
    );

    return rows.map((row) => ({
      id: String(row.id),
      eventType: String(row.event_type),
      aggregateId: String(row.aggregate_id),
      payload: toPayload(row.payload),
      attempts: Number(row.attempts),
    }));
  }

  /**
   * Tentativa consumida e nova janela de elegibilidade, gravadas ANTES de
   * soltar a linha — o mesmo mecanismo do claim da §7.1
   * (`recordReferenceAttempt`). É o que torna o crash entre o claim e a
   * publicação auto-recuperável: a mensagem volta a ser elegível sozinha,
   * sem lock órfão nem estado `PROCESSING`.
   */
  async recordAttempt(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageEntity,
      { id },
      { attempts, nextAttemptAt },
    );
  }

  /** §6.5 `markPublished(at)` — estado terminal da mensagem. */
  async markPublished(id: string, at: Date): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageEntity,
      { id },
      {
        status: OutboxMessageStatus.PUBLISHED,
        publishedAt: at,
        lastError: null,
      },
    );
  }

  /** Registra o motivo da última falha, sem mudar estado nem janela. */
  async recordFailure(id: string, detail: string): Promise<void> {
    await this.em.nativeUpdate(OutboxMessageEntity, { id }, { lastError: detail });
  }
}
