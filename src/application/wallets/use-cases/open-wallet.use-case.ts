import { randomUUID } from 'node:crypto';
import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { Money } from '../../../domain/shared/value-objects/money.js';
import { Wallet } from '../../../domain/wallets/wallet.js';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry.js';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';
import { WalletRepository } from '../../../infrastructure/persistence/repositories/wallet.repository.js';
import { WalletLedgerRepository } from '../../../infrastructure/persistence/repositories/wallet-ledger.repository.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
} from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import {
  LedgerDirection,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from '../../../infrastructure/persistence/entities/outbox-message.entity.js';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: Money;
  correlationId?: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

/**
 * Abertura interna de carteira (README 9).
 *
 * A wallet é criada com `version = 1`. Um saldo inicial positivo gera, na
 * MESMA transação SQL, a transação interna `OPENING` (PROCESSED, sem
 * provedor/idempotência — a migration inicial exige NULL nesses campos),
 * o lançamento `CREDIT` no ledger (saldo anterior zero) e o evento
 * `WalletBalanceChanged` na outbox. Saldo zero cria apenas a carteira.
 *
 * O `OPENING` é interno: não recebe `Idempotency-Key` nem metadados de
 * provedor, conforme o contrato documentado.
 *
 * A duplicidade `playerId + currency` é tratada nos dois níveis: uma
 * pré-checagem para falhar cedo e a captura da violação de unicidade
 * vinda do banco — esta é a garantia real sob concorrência, pois a
 * pré-checagem sozinha tem janela de corrida.
 */
export class OpenWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletResult> {
    this.validateInput(input);

    const initialBalance = input.initialBalance;

    try {
      return await this.em.transactional(async (txEm) => {
        const walletRepository = new WalletRepository(txEm);

        const existing = await walletRepository.findByPlayerAndCurrency(
          input.playerId,
          initialBalance.currency,
        );

        if (existing) {
          throw new Error('WALLET_ALREADY_EXISTS');
        }

        const now = new Date();

        // A abertura é a própria criação: `Wallet.create` inicia em
        // version 1 e não passa por `credit()`, que incrementaria a versão.
        const wallet = Wallet.create({
          id: randomUUID(),
          playerId: input.playerId,
          initialBalance,
          createdAt: now,
        });

        const walletEntity = new WalletEntity();
        walletEntity.id = wallet.id;
        walletEntity.playerId = wallet.playerId;
        walletEntity.currency = wallet.balance.currency;
        walletEntity.balance = wallet.balance.toJSON().amount;
        walletEntity.version = wallet.version;
        walletEntity.createdAt = wallet.createdAt;
        walletEntity.updatedAt = wallet.updatedAt;

        txEm.persist(walletEntity);

        if (initialBalance.isPositive()) {
          await this.registerOpening(
            txEm,
            wallet,
            initialBalance,
            input.correlationId,
            now,
          );
        }

        // Um único flush cobre wallet, OPENING, ledger e outbox: o
        // Unit of Work ordena os INSERTs pelas chaves estrangeiras.
        await txEm.flush();

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      // Corrida entre a pré-checagem e o INSERT: o banco é quem decide.
      if (error instanceof UniqueConstraintViolationException) {
        throw new Error('WALLET_ALREADY_EXISTS');
      }

      throw error;
    }
  }

  private async registerOpening(
    txEm: EntityManager,
    wallet: Wallet,
    initialBalance: Money,
    correlationId: string | undefined,
    now: Date,
  ): Promise<void> {
    const opening = WagerTransaction.createOpening({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: initialBalance,
      createdAt: now,
    });

    const openingEntity = new WagerTransactionEntity();
    openingEntity.id = opening.id;
    openingEntity.wallet = txEm.getReference(WalletEntity, wallet.id);
    openingEntity.playerId = opening.playerId;
    openingEntity.providerId = opening.providerId;
    openingEntity.externalTransactionId = opening.externalTransactionId;
    openingEntity.idempotencyKey = opening.idempotencyKey;
    openingEntity.payloadHash = opening.payloadHash;
    openingEntity.roundId = null;
    openingEntity.gameId = null;
    openingEntity.kind = opening.kind;
    openingEntity.status = opening.status;
    openingEntity.amount = opening.money.toJSON().amount;
    openingEntity.currency = opening.money.currency;
    openingEntity.referenceExternalTransactionId =
      opening.referenceExternalTransactionId;
    openingEntity.referenceTransaction = null;
    openingEntity.rejectionReason = null;
    openingEntity.resultBalanceAmount = wallet.balance.toJSON().amount;
    openingEntity.resultBalanceCurrency = wallet.balance.currency;
    openingEntity.resultWalletVersion = wallet.version;
    openingEntity.createdAt = opening.createdAt;
    openingEntity.updatedAt = opening.createdAt;
    openingEntity.processedAt = opening.processedAt;

    txEm.persist(openingEntity);

    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.CREDIT,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });

    const ledgerRepository = new WalletLedgerRepository(txEm);
    ledgerRepository.create({
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      currency: entry.money.currency,
      createdAt: entry.createdAt,
    });

    this.persistOutboxEvent(
      txEm,
      {
        eventId: randomUUID(),
        aggregateId: wallet.id,
        correlationId: correlationId ?? opening.id,
        occurredAt: now.toISOString(),
        eventType: 'WalletBalanceChanged',
        version: 1,
        data: {
          walletId: wallet.id,
          transactionId: opening.id,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
      },
      now,
    );
  }

  private persistOutboxEvent(
    em: EntityManager,
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): void {
    const event = new OutboxMessageEntity();
    event.id = payload.eventId as string;
    event.eventType = payload.eventType as string;
    event.aggregateId = payload.aggregateId as string;
    event.payload = payload;
    event.status = OutboxMessageStatus.PENDING;
    event.attempts = 0;
    event.nextAttemptAt = occurredAt;
    event.occurredAt = occurredAt;
    event.createdAt = occurredAt;

    em.persist(event);
  }

  private validateInput(input: OpenWalletInput): void {
    if (typeof input.playerId !== 'string' || !input.playerId.trim()) {
      throw new Error('INVALID_PLAYER_ID');
    }

    if (!(input.initialBalance instanceof Money)) {
      throw new Error('INVALID_INITIAL_BALANCE');
    }
  }
}
