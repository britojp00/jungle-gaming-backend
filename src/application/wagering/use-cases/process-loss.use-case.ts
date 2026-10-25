import { randomUUID } from 'node:crypto';

import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { Money } from '../../../domain/shared/value-objects/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../domain/wagering/wager-transaction.js';
import { WalletRepository } from '../../../infrastructure/persistence/repositories/wallet.repository.js';
import { WagerTransactionEntity } from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { hashWagerPayload } from '../payload-hash.js';
import {
  persistOutboxEvent,
  resolveConcurrentDuplicate,
  toProcessResult,
  toTransactionEntity,
  validateRequiredStrings,
  WagerProcessResult,
} from '../process-support.js';

export interface ProcessLossInput {
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  correlationId?: string;
}

/**
 * `LOSS` (README §7): registra o resultado **sem mover saldo** e sem
 * lançamento no ledger — e ainda assim é "transação aplicada", logo emite
 * `WagerTransactionProcessed` (§11: "qualquer transação aplicada, inclusive
 * `LOSS`").
 */
export class ProcessLossUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessLossInput): Promise<WagerProcessResult> {
    validateRequiredStrings({
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      roundId: input.roundId,
      gameId: input.gameId,
    });

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new Error('LOSS amount must be positive');
    }

    const payloadHash = hashWagerPayload({
      kind: WagerTransactionKind.LOSS,
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      amount: input.amount,
      currency: input.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      referenceExternalTransactionId: null,
    });

    const now = new Date();
    const loss = WagerTransaction.createLoss({
      id: randomUUID(),
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      roundId: input.roundId,
      gameId: input.gameId,
      money: amount,
      createdAt: now,
    });

    return this.em
      .transactional(async (txEm) => {
        const walletRepository = new WalletRepository(txEm);
        const wallet = await walletRepository.findByIdForUpdate(input.walletId);

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        if (wallet.playerId !== input.playerId) {
          throw new Error('WALLET_PLAYER_MISMATCH');
        }

        if (wallet.balance.currency !== input.currency) {
          throw new Error('CURRENCY_MISMATCH');
        }

        const existing = await txEm.findOne(WagerTransactionEntity, {
          providerId: input.providerId,
          idempotencyKey: input.idempotencyKey,
        });

        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
          }

          return toProcessResult(existing, true);
        }

        // LOSS é aplicada (§6.3): `PROCESSED`, sem saldo e sem ledger.
        loss.markProcessed(undefined, now);
        const transaction = toTransactionEntity(loss, wallet, txEm);
        txEm.persist(transaction);

        // §7: LOSS não move saldo nem gera ledger — só a transação e o evento.
        persistOutboxEvent(
          txEm,
          {
            eventId: randomUUID(),
            aggregateId: transaction.id,
            correlationId: input.correlationId ?? transaction.id,
            occurredAt: now.toISOString(),
            eventType: 'WagerTransactionProcessed',
            version: 1,
            data: {
              transactionId: transaction.id,
              playerId: input.playerId,
              walletId: input.walletId,
              kind: transaction.kind,
              status: transaction.status,
              amount: amount.toJSON(),
              balance: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          },
          now,
        );

        await txEm.flush();

        return toProcessResult(transaction, false);
      })
      .catch(async (error) => {
        if (error instanceof UniqueConstraintViolationException) {
          return resolveConcurrentDuplicate(
            this.em,
            {
              providerId: input.providerId,
              idempotencyKey: input.idempotencyKey,
            },
            payloadHash,
            error,
            toProcessResult,
          );
        }

        throw error;
      });
  }
}
