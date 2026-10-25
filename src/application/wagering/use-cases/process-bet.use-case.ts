
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
import { WalletRepository } from '../../../infrastructure/persistence/repositories/wallet.repository.js';
import { WalletLedgerEntryEntity, LedgerDirection } from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
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

export interface ProcessBetInput {
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  /**
   * Obrigatórios: o README 6.3 os tipa como não anuláveis em
   * `WagerTransaction`, o §9 os traz no corpo de `POST /wagering/transactions`
   * e o §10 na mensagem SQS. Entrada sem eles é payload inválido, não caminho
   * de negócio (`INVALID_ROUNDID` / `INVALID_GAMEID`).
   */
  roundId: string;
  gameId: string;
  correlationId?: string;
}

/**
 * Resultado comum a BET e WIN (README §9): transação, saldo observado,
 * versão da carteira e `idempotentReplay`. A máquina compartilhada vive em
 * `../process-support.ts`.
 */
export type ProcessBetResult = WagerProcessResult;

export class ProcessBetUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessBetInput): Promise<ProcessBetResult> {
    // Payload inválido falha ANTES de qualquer acesso ao banco (README §9):
    // a API distingue payload inválido de regra de negócio.
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
      throw new Error('BET amount must be positive');
    }

    const payloadHash = hashWagerPayload({
      kind: WagerTransactionKind.BET,
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

    // A BET nasce no domínio (README 6.3): `createBet` valida campos
    // obrigatórios, limites de coluna, formato do hash e valor positivo
    // ANTES de tocar o banco — payload inválido nunca alcança a wallet.
    const bet = WagerTransaction.createBet({
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

    return this.em.transactional(async (txEm) => {
      const walletRepository = new WalletRepository(txEm);

      // Lock the wallet before checking idempotency again. Concurrent
      // bets on the same wallet will serialize on this database row.
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

      const balanceBefore = wallet.balance;
      const hasFunds = !balanceBefore.isLessThan(amount);

      if (hasFunds) {
        wallet.debit(amount, now);
        await walletRepository.save(wallet);
        // PENDING → PROCESSED (README 6.3); a BET não tem referência.
        bet.markProcessed(undefined, now);
      } else {
        // PENDING → REJECTED (README §7, regra 6): não move saldo nem gera
        // lançamento, com o código centralizado da taxonomia §7.2.
        bet.reject(FailureCode.INSUFFICIENT_FUNDS);
      }

      const transaction = toTransactionEntity(bet, wallet, txEm);
      txEm.persist(transaction);

      if (hasFunds) {
        const ledger = new WalletLedgerEntryEntity();
        ledger.id = randomUUID();
        ledger.wallet = txEm.getReference(WalletEntity, input.walletId);
        ledger.transaction = transaction;
        ledger.direction = LedgerDirection.DEBIT;
        ledger.amount = amount.toJSON().amount;
        ledger.balanceBefore = balanceBefore.toJSON().amount;
        ledger.balanceAfter = wallet.balance.toJSON().amount;
        ledger.currency = amount.currency;
        ledger.createdAt = now;

        txEm.persist(ledger);
      }

      const transactionEventType = hasFunds
        ? 'WagerTransactionProcessed'
        : 'WagerTransactionRejected';

      persistOutboxEvent(txEm, {
        eventId: randomUUID(),
        aggregateId: transaction.id,
        correlationId: input.correlationId ?? transaction.id,
        occurredAt: now.toISOString(),
        eventType: transactionEventType,
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
          ...(hasFunds
            ? {}
            : { failureCode: FailureCode.INSUFFICIENT_FUNDS }),
        },
      }, now);

      if (hasFunds) {
        persistOutboxEvent(txEm, {
          eventId: randomUUID(),
          aggregateId: input.walletId,
          correlationId: input.correlationId ?? transaction.id,
          occurredAt: now.toISOString(),
          eventType: 'WalletBalanceChanged',
          version: 1,
          data: {
            walletId: input.walletId,
            transactionId: transaction.id,
            // Reflete o lançamento DEBIT criado acima para esta BET.
            direction: LedgerDirection.DEBIT,
            money: amount.toJSON(),
            balanceBefore: balanceBefore.toJSON(),
            balanceAfter: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          },
        }, now);
      }

      // Flushes all pending changes inside the same SQL transaction.
      await txEm.flush();

      return toProcessResult(transaction, false);
    }).catch(async (error) => {
      // Requisições concorrentes com a MESMA chave de idempotência em
      // wallets DIFERENTES não se serializam no lock da carteira e disputam
      // a unique de idempotência no banco. Ver `resolveConcurrentDuplicate`.
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
