
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { LedgerDirection } from '../../../domain/ledger/wallet-ledger-entry.js';
import { WalletEntity } from './wallet.entity.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';

// O vocabulário de domínio é a fonte única; a entidade apenas o reexporta
// para manter os imports atuais desta camada.
export { LedgerDirection };

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'wallet_ledger_wallet_transaction_unique',
  properties: ['wallet', 'transaction'],
})
@Check({
  name: 'wallet_ledger_amount_positive',
  expression: 'amount > 0',
})
@Check({
  name: 'wallet_ledger_balance_before_non_negative',
  expression: 'balance_before >= 0',
})
@Check({
  name: 'wallet_ledger_balance_after_non_negative',
  expression: 'balance_after >= 0',
})
@Check({
  name: 'wallet_ledger_direction_valid',
  expression: "direction IN ('CREDIT', 'DEBIT')",
})
@Check({
  name: 'wallet_ledger_balance_consistent',
  expression:
    "(direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount)",
})
@Index({
  name: 'wallet_ledger_wallet_created_idx',
  properties: ['wallet', 'createdAt'],
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, {
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: WalletEntity;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'transaction_id',
    deleteRule: 'restrict',
  })
  transaction!: WagerTransactionEntity;

  @Property({ type: 'string', length: 10 })
  direction!: LedgerDirection;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({
    name: 'balance_before',
    type: 'numeric',
    precision: 20,
    scale: 2,
  })
  balanceBefore!: string;

  @Property({
    name: 'balance_after',
    type: 'numeric',
    precision: 20,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    name: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt = new Date();
}
