import { randomUUID } from 'node:crypto';

import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { Money } from '../../../domain/shared/value-objects/money.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../domain/wagering/wager-transaction.js';
import {
  LedgerDirection,
  WalletLedgerEntryEntity,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity, WagerTransactionStatus } from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerRepository } from '../../../infrastructure/persistence/repositories/wallet-ledger.repository.js';
import { WalletRepository } from '../../../infrastructure/persistence/repositories/wallet.repository.js';
import { hashWagerPayload } from '../payload-hash.js';
import {
  applyTransactionState,
  evaluateReversal,
  persistOutboxEvent,
  resolveConcurrentDuplicate,
  resolveReference,
  toProcessResult,
  toTransactionEntity,
  validateRequiredStrings,
  WagerProcessResult,
} from '../process-support.js';

export interface ProcessReversalInput {
  kind: WagerTransactionKind.REFUND | WagerTransactionKind.ROLLBACK;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  referenceExternalTransactionId: string;
  correlationId?: string;
}

/**
 * `REFUND` e `ROLLBACK` (README §7).
 *
 * - **regra 1**: `referenceExternalTransactionId` é obrigatório;
 * - **regra 2**: a referência pertence ao mesmo provider/player/wallet/moeda/
 *   rodada (`resolveReference`);
 * - **regra 3**: `REFUND` só reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou
 *   `REFUND` (`WagerTransaction.ledgerDirectionFor`);
 * - **regra 4**: a mesma referência não é revertida duas vezes pelo mesmo tipo
 *   (índice `wager_transactions_reversal_unique`);
 * - **regra 5**: o valor é **igual** ao da referência;
 * - **regra 9**: reversão que produziria saldo negativo é rejeitada com
 *   `INSUFFICIENT_BALANCE_FOR_REVERSAL`, distinto de saldo insuficiente para
 *   aposta;
 * - **regra 6/7**: rejeição não move saldo; replay devolve o resultado.
 */
export class ProcessReversalUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessReversalInput): Promise<WagerProcessResult> {
    validateRequiredStrings({
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      roundId: input.roundId,
      gameId: input.gameId,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new Error(`${input.kind} amount must be positive`);
    }

    const payloadHash = hashWagerPayload({
      kind: input.kind,
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      amount: input.amount,
      currency: input.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    const now = new Date();

    const reversal =
      input.kind === WagerTransactionKind.REFUND
        ? WagerTransaction.createRefund({
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
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
            createdAt: now,
          })
        : WagerTransaction.createRollback({
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
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
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

        const transaction = toTransactionEntity(reversal, wallet, txEm);
        txEm.persist(transaction);

        const criteria = {
          providerId: input.providerId,
          playerId: input.playerId,
          currency: input.currency,
          roundId: input.roundId,
          walletId: input.walletId,
        };

        const resolution = await resolveReference(
          txEm,
          criteria,
          input.referenceExternalTransactionId,
          reversal.id,
        );

        if (resolution.outcome === 'pending') {
          // Regra 8: referência ausente → reprocesso posterior (§7.1).
          reversal.markPendingReference();
          applyTransactionState(transaction, reversal, wallet, txEm);

          persistOutboxEvent(
            txEm,
            {
              eventId: randomUUID(),
              aggregateId: transaction.id,
              correlationId: input.correlationId ?? transaction.id,
              occurredAt: now.toISOString(),
              eventType: 'WagerTransactionPendingReference',
              version: 1,
              data: {
                transactionId: transaction.id,
                playerId: input.playerId,
                walletId: input.walletId,
                kind: transaction.kind,
                status: transaction.status,
                amount: amount.toJSON(),
                referenceExternalTransactionId:
                  input.referenceExternalTransactionId,
              },
            },
            now,
          );

          await txEm.flush();

          return toProcessResult(transaction, false);
        }

        if (resolution.outcome === 'mismatch') {
          reversal.reject(FailureCode.REFERENCE_MISMATCH);
          applyTransactionState(transaction, reversal, wallet, txEm);
          this.persistRejectedEvent(txEm, transaction, input, now);
          await txEm.flush();

          return toProcessResult(transaction, false);
        }

        const target = await txEm.findOne(WagerTransactionEntity, {
          id: resolution.targetId,
        });

        const targetDomain = WagerTransaction.rehydrate({
          id: target!.id,
          walletId: input.walletId,
          playerId: target!.playerId,
          providerId: target!.providerId,
          externalTransactionId: target!.externalTransactionId,
          idempotencyKey: target!.idempotencyKey,
          payloadHash: target!.payloadHash,
          roundId: target!.roundId,
          gameId: target!.gameId,
          kind: target!.kind,
          money: Money.from({ amount: target!.amount, currency: target!.currency }),
          referenceExternalTransactionId:
            target!.referenceExternalTransactionId,
          referenceTransactionId: target!.referenceTransaction?.id ?? null,
          createdAt: target!.createdAt,
          status: target!.status,
          failureCode: target!.rejectionReason as FailureCode | null,
          processedAt: target!.processedAt,
        });

        // Regras 3, 4, 5 e 9 — o MESMO julgamento que o worker de §7.1 aplica
        // quando a reversão nasce pendente e é resolvida depois.
        const alreadyReversed = await txEm.findOne(WagerTransactionEntity, {
          providerId: input.providerId,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          kind: input.kind,
          status: WagerTransactionStatus.PROCESSED,
        });

        const evaluation = evaluateReversal({
          reversal,
          target: targetDomain,
          amount,
          walletBalance: wallet.balance,
          alreadyReversed: alreadyReversed !== null,
        });

        if (evaluation.outcome === 'reject') {
          reversal.reject(evaluation.failureCode);
          applyTransactionState(transaction, reversal, wallet, txEm);
          this.persistRejectedEvent(txEm, transaction, input, now);
          await txEm.flush();

          return toProcessResult(transaction, false);
        }

        const direction = evaluation.direction;
        const balanceBefore = wallet.balance;

        if (direction === LedgerDirection.CREDIT) {
          wallet.credit(amount, now);
        } else {
          wallet.debit(amount, now);
        }

        await walletRepository.save(wallet);

        reversal.markProcessed(target!.id, now);
        applyTransactionState(transaction, reversal, wallet, txEm);

        const ledger = new WalletLedgerEntryEntity();
        ledger.id = randomUUID();
        ledger.wallet = txEm.getReference(WalletEntity, input.walletId);
        ledger.transaction = transaction;
        ledger.direction = direction;
        ledger.amount = amount.toJSON().amount;
        ledger.balanceBefore = balanceBefore.toJSON().amount;
        ledger.balanceAfter = wallet.balance.toJSON().amount;
        ledger.currency = amount.currency;
        ledger.createdAt = now;
        new WalletLedgerRepository(txEm).persist(ledger);

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

        persistOutboxEvent(
          txEm,
          {
            eventId: randomUUID(),
            aggregateId: input.walletId,
            correlationId: input.correlationId ?? transaction.id,
            occurredAt: now.toISOString(),
            eventType: 'WalletBalanceChanged',
            version: 1,
            data: {
              walletId: input.walletId,
              transactionId: transaction.id,
              direction,
              money: amount.toJSON(),
              balanceBefore: balanceBefore.toJSON(),
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          },
          now,
        );

        await txEm.flush();

        return toProcessResult(transaction, false);
      })
      .catch(async (error) => {
        // Regra 4 garantida pelo banco: a unique `wager_transactions_reversal_unique`
        // impede até registrar uma segunda reversão da mesma referência.
        if (
          error instanceof UniqueConstraintViolationException &&
          String(error.message).includes('wager_transactions_reversal_unique')
        ) {
          throw new Error('REFERENCE_ALREADY_REVERSED');
        }

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

  private persistRejectedEvent(
    txEm: EntityManager,
    transaction: WagerTransactionEntity,
    input: ProcessReversalInput,
    now: Date,
  ): void {
    persistOutboxEvent(
      txEm,
      {
        eventId: randomUUID(),
        aggregateId: transaction.id,
        correlationId: input.correlationId ?? transaction.id,
        occurredAt: now.toISOString(),
        eventType: 'WagerTransactionRejected',
        version: 1,
        data: {
          transactionId: transaction.id,
          playerId: input.playerId,
          walletId: input.walletId,
          kind: transaction.kind,
          status: transaction.status,
          amount: Money.from({
            amount: input.amount,
            currency: input.currency,
          }).toJSON(),
          failureCode: transaction.rejectionReason,
        },
      },
      now,
    );
  }
}
