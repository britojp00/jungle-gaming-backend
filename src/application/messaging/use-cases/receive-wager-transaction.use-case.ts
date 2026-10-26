import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';

import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction.js';
import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { InboxMessageRepository } from '../../../infrastructure/persistence/repositories/inbox-message.repository.js';
import { hashWagerPayload } from '../../wagering/payload-hash.js';
import { WagerProcessResult } from '../../wagering/process-support.js';
import {
  ProcessBetUseCase,
} from '../../wagering/use-cases/process-bet.use-case.js';
import {
  ProcessLossUseCase,
} from '../../wagering/use-cases/process-loss.use-case.js';
import {
  ProcessReversalUseCase,
} from '../../wagering/use-cases/process-reversal.use-case.js';
import {
  ProcessWinInput,
  ProcessWinUseCase,
} from '../../wagering/use-cases/process-win.use-case.js';
import {
  WagerTransactionRequested,
} from '../wager-transaction-requested.js';

/**
 * Nome **lógico** do consumidor: a chave da Inbox é `(consumerName,
 * messageId)` (§10) e precisa ser igual em todas as instâncias — se fosse por
 * processo, nada seria deduplicado entre elas.
 */
export const WAGER_COMMAND_CONSUMER_NAME = 'wager-transactions';

export interface ReceiveWagerTransactionOptions {
  /** Relógio do processamento — sem `Date.now()` escondido. */
  now?: Date;
  consumerName?: string;
}

export interface ReceiveWagerTransactionResult {
  /**
   * - `processed`/`rejected`: o caso de uso aplicou (ou rejeitou por regra) e
   *   a transação foi persistida;
   * - `replayed`: a mensagem já tinha sido aplicada antes (idempotência do
   *   negócio);
   * - `duplicate`: a própria mensagem já havia sido confirmada (Inbox).
   */
  outcome: 'processed' | 'rejected' | 'replayed' | 'duplicate';
  transactionId?: string;
  status?: string;
  failureCode?: string;
}

/**
 * Processa uma mensagem `WagerTransactionRequested` (README §10).
 *
 * **Atomicidade (§11):** Inbox, operação financeira, ledger e outbox entram e
 * saem na MESMA transação PostgreSQL. O caso de uso abre uma transação,
 * registra a Inbox e chama `ProcessBetUseCase`/`ProcessWinUseCase` com o
 * MESMO `EntityManager` — o `transactional` interno deles vira savepoint na
 * mesma conexão (MikroORM v7: `TransactionManager.executeNestedTransaction`
 * → `AbstractSqlConnection.begin` com `ctx`). Nada é confirmado pela metade:
 * em qualquer falha, a transação inteira desfaz, Inbox incluída.
 *
 * **Idempotência:** a garantia é persistente (§5.2) — a unique
 * `(consumer_name, message_id)` da Inbox e a unique de idempotência dos
 * casos de uso. Redelivery e mensagens repetidas não produzem efeito novo.
 */
export class ReceiveWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    message: WagerTransactionRequested,
    options: ReceiveWagerTransactionOptions = {},
  ): Promise<ReceiveWagerTransactionResult> {
    const now = options.now ?? new Date();
    const consumerName = options.consumerName ?? WAGER_COMMAND_CONSUMER_NAME;

    return this.em.transactional(async (txEm) => {
      const repository = new InboxMessageRepository(txEm);
      const existing = await repository.findByMessageKey(
        consumerName,
        message.messageId,
      );

      if (existing?.isProcessed()) {
        // Entrega repetida de mensagem já confirmada (§10): não há efeito a
        // repetir e nada muda — o consumidor confirma de novo.
        return { outcome: 'duplicate' };
      }

      const inbox = InboxMessage.receive({
        id: randomUUID(),
        consumerName,
        messageId: message.messageId,
        eventType: message.type,
        payloadHash: hashWagerPayload({
          kind: message.data.kind,
          walletId: message.data.walletId,
          playerId: message.data.playerId,
          providerId: message.data.providerId,
          externalTransactionId: message.data.externalTransactionId,
          amount: message.data.money.amount,
          currency: message.data.money.currency,
          roundId: message.data.roundId,
          gameId: message.data.gameId,
          referenceExternalTransactionId:
            message.data.referenceExternalTransactionId ?? null,
        }),
        payload: {
          messageId: message.messageId,
          type: message.type,
          occurredAt: message.occurredAt.toISOString(),
          data: { ...message.data },
        },
        receivedAt: now,
      });

      await repository.save(inbox);

      const result = await this.dispatch(txEm, message);

      inbox.markProcessed(now);
      await repository.save(inbox);

      return {
        outcome:
          result.replayed
            ? 'replayed'
            : result.status === 'REJECTED'
              ? 'rejected'
              : 'processed',
        transactionId: result.transactionId,
        status: result.status,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      };
    });
  }

  /**
   * Reutiliza os MESMOS casos de uso da entrada (§10: "reutilizar o mesmo
   * use case da entrada HTTP"): `BET` → `ProcessBetUseCase`, `LOSS` →
   * `ProcessLossUseCase`, `REFUND`/`ROLLBACK` → `ProcessReversalUseCase` e
   * `WIN` → `ProcessWinUseCase`.
   */
  private async dispatch(
    txEm: EntityManager,
    message: WagerTransactionRequested,
  ): Promise<WagerProcessResult> {
    const { data } = message;

    const base = {
      walletId: data.walletId,
      playerId: data.playerId,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: data.idempotencyKey,
      amount: data.money.amount,
      currency: data.money.currency,
      roundId: data.roundId,
      gameId: data.gameId,
    };

    if (data.kind === WagerTransactionKind.BET) {
      return new ProcessBetUseCase(txEm).execute(base);
    }

    if (data.kind === WagerTransactionKind.LOSS) {
      return new ProcessLossUseCase(txEm).execute(base);
    }

    if (
      data.kind === WagerTransactionKind.REFUND ||
      data.kind === WagerTransactionKind.ROLLBACK
    ) {
      return new ProcessReversalUseCase(txEm).execute({
        ...base,
        kind: data.kind,
        referenceExternalTransactionId: data.referenceExternalTransactionId!,
      });
    }

    const win: ProcessWinInput = {
      ...base,
      ...(data.referenceExternalTransactionId
        ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
        : {}),
    };

    return new ProcessWinUseCase(txEm).execute(win);
  }
}
