import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

/**
 * Converte o que o Postgres devolve para `timestamptz` em `Date`.
 *
 * A consulta crua devolve a string literal (`2026-10-25 02:12:18.68+00`) —
 * driver sem parser de tipo aplicado. Normaliza para ISO-8601 com `T` e
 * offset `+HH:MM`, formato que todo motor aceita, porque `created_at` alimenta
 * o cálculo do TTL: um parse silenciosamente errado deslocaria o prazo.
 * Estoura `REFERENCE_CREATED_AT_INVALID` em vez de seguir com `Invalid Date`.
 */
function toReferenceDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(
    String(value)
      .replace(' ', 'T')
      .replace(/([+-]\d{2})$/, '$1:00'),
  );

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('REFERENCE_CREATED_AT_INVALID');
  }

  return parsed;
}

/**
 * Uma linha `PENDING_REFERENCE` selecionada pelo claim. Os campos vêm em
 * colunas (não em relação) porque a seleção acontece ANTES do lock da wallet
 * e a linha ainda pode estar em qualquer estado.
 */
export interface PendingReferenceClaim {
  id: string;
  walletId: string;
  /** Tentativas já contadas no banco, ANTES do incremento deste claim. */
  referenceAttempts: number;
  createdAt: Date;
}

export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransactionEntity | null> {
    return this.em.findOne(WagerTransactionEntity, { id });
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransactionEntity | null> {
    return this.em.findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey,
    });
  }

  async findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionEntity | null> {
    return this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
  }

  /**
   * Seleção das linhas elegíveis ao reprocessamento (README §7.1).
   *
   * - `reference_next_attempt_at <= ?` é a janela gravada no claim anterior
   *   (backoff) e é a ÚNICA condição de elegibilidade: o TTL não aparece
   *   aqui porque a própria janela nunca é agendada além do prazo — ver
   *   `nextReferenceAttemptAt` em `application/wagering/reference-retry-policy.ts`;
   * - `ORDER BY reference_next_attempt_at, id` dá a mesma ordem a todas as
   *   instâncias, e o índice parcial
   *   `wager_transactions_pending_reference_idx` cobre filtro + ordenação;
   * - `FOR UPDATE SKIP LOCKED` (claim concorrente): duas instâncias nunca
   *   disputam a mesma linha — quem chega depois pula a trava e leva outra.
   *   A trava vale só durante a transação do claim; a garantia de não
   *   aplicar duas vezes não vem daqui, e sim do lock da wallet + releitura
   *   dentro da transação financeira.
   *
   * `?` é o placeholder nativo do MikroORM (formatado para a plataforma),
   * não `$1`.
   */
  async claimPendingReferences(
    limit: number,
    now: Date,
  ): Promise<PendingReferenceClaim[]> {
    const rows = await this.em.execute(
      `select id, wallet_id, reference_attempts, created_at
         from wager_transactions
        where status = 'PENDING_REFERENCE'
          and reference_next_attempt_at <= ?
        order by reference_next_attempt_at, id
        limit ?
        for update skip locked`,
      [now, limit],
    );

    return rows.map((row) => ({
      id: String(row.id),
      walletId: String(row.wallet_id),
      referenceAttempts: Number(row.reference_attempts),
      createdAt: toReferenceDate(row.created_at),
    }));
  }

  /**
   * Grava o resultado do claim: a tentativa consumida e a próxima janela,
   * ANTES de liberar a linha. Um crash depois disto não perde a pendência
   * (a linha segue `PENDING_REFERENCE`) e não reinicia um ciclo imediato
   * (a janela futura já está gravada) — documentado em `ARCHITECTURE.md`.
   */
  async recordReferenceAttempt(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionEntity,
      { id },
      { referenceAttempts: attempts, referenceNextAttemptAt: nextAttemptAt },
    );
  }

  persist(transaction: WagerTransactionEntity): void {
    this.em.persist(transaction);
  }
}