import { EntityManager } from '@mikro-orm/postgresql';
import { LedgerDirection, WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  currency: string;
  createdAt: Date;
}

export class WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async findByTransactionId(
    transactionId: string,
  ): Promise<WalletLedgerEntryEntity | null> {
    return this.em.findOne(WalletLedgerEntryEntity, {
      transaction: transactionId,
    });
  }

  /**
   * Lançamentos da wallet em ordem estável (`created_at`, depois `id`) — é o
   * que sustenta o cursor opaco do ledger (§9) e a reconstrução de saldo.
   */
  async findByWalletId(
    walletId: string,
    options: { after?: { createdAt: Date; id: string }; limit?: number } = {},
  ): Promise<WalletLedgerEntryEntity[]> {
    const after = options.after;

    return this.em.find(
      WalletLedgerEntryEntity,
      {
        wallet: walletId,
        ...(after
          ? {
              $or: [
                { createdAt: { $gt: after.createdAt } },
                { createdAt: after.createdAt, id: { $gt: after.id } },
              ],
            }
          : {}),
      },
      {
        orderBy: { createdAt: 'asc', id: 'asc' },
        // Um item além do limite permite saber se há próxima página.
        ...(options.limit === undefined
          ? {}
          : { limit: options.limit + 1 }),
      },
    );
  }

  create(props: CreateWalletLedgerEntryProps): WalletLedgerEntryEntity {
    const entry = new WalletLedgerEntryEntity();

    entry.id = props.id;
    entry.wallet = this.em.getReference(WalletEntity, props.walletId);
    entry.transaction = this.em.getReference(
      WagerTransactionEntity,
      props.transactionId,
    );
    entry.direction = props.direction;
    entry.amount = props.amount;
    entry.balanceBefore = props.balanceBefore;
    entry.balanceAfter = props.balanceAfter;
    entry.currency = props.currency;
    entry.createdAt = props.createdAt;

    this.em.persist(entry);

    return entry;
  }

  persist(entry: WalletLedgerEntryEntity): void {
    this.em.persist(entry);
  }
}
