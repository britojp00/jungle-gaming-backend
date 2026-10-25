import { Money } from '../shared/value-objects/money.js';

export enum LedgerDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface RehydrateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger (README 6.4).
 *
 * A imutabilidade é estrutural: construtor privado, sem campos mutáveis e
 * sem métodos de transição. `create` valida os dados e a aritmética do
 * lançamento, espelhando as constraints da migration inicial:
 * - `wallet_ledger_amount_positive`        -> amount > 0
 * - `wallet_ledger_balance_before_non_negative` -> balance_before >= 0
 * - `wallet_ledger_balance_after_non_negative`  -> balance_after >= 0
 * - `wallet_ledger_direction_valid`        -> direction IN ('CREDIT', 'DEBIT')
 * - `wallet_ledger_balance_consistent`     -> CREDIT: after = before + amount
 *                                             DEBIT:  after = before - amount
 *
 * `rehydrate` reconstrói estado já persistido sem revalidar (README 6.0);
 * a integridade dos dados vem do banco e `isBalanced()` expõe a checagem
 * de aritmética para reconciliação.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(
    props: CreateWalletLedgerEntryProps,
  ): WalletLedgerEntry {
    if (!props.id.trim()) {
      throw new Error('Ledger entry ID is required');
    }

    if (!props.walletId.trim()) {
      throw new Error('Wallet ID is required');
    }

    if (!props.transactionId.trim()) {
      throw new Error('Transaction ID is required');
    }

    if (
      !Object.values(LedgerDirection).includes(props.direction)
    ) {
      throw new Error('Invalid ledger direction');
    }

    if (!props.money.isPositive()) {
      throw new Error('Ledger amount must be positive');
    }

    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new Error('Ledger balances cannot be negative');
    }

    WalletLedgerEntry.assertSameCurrency(props);

    const expectedBalanceAfter =
      props.direction === LedgerDirection.CREDIT
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);

    if (!expectedBalanceAfter.equals(props.balanceAfter)) {
      throw new Error('Ledger entry is not balanced');
    }

    const createdAt = props.createdAt ?? new Date();

    WalletLedgerEntry.assertValidDate(createdAt);

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      createdAt,
    );
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(
    props: RehydrateWalletLedgerEntryProps,
  ): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    const expectedBalanceAfter =
      this.direction === LedgerDirection.CREDIT
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedBalanceAfter.equals(this.balanceAfter);
  }

  private static assertSameCurrency(
    props: CreateWalletLedgerEntryProps,
  ): void {
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new Error('Currency mismatch');
    }
  }

  private static assertValidDate(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }
  }
}
