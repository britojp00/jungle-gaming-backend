
import { Money } from '../shared/value-objects/money.js';

export interface CreateWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface RehydrateWalletProps {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private currentBalance: Money;
  private currentVersion: number;
  private currentUpdatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    balance: Money,
    version: number,
    public readonly createdAt: Date,
    updatedAt: Date,
  ) {
    this.currentBalance = balance;
    this.currentVersion = version;
    this.currentUpdatedAt = new Date(updatedAt);
  }

  static create(props: CreateWalletProps): Wallet {
    if (!props.id.trim()) {
      throw new Error('Wallet ID is required');
    }

    if (!props.playerId.trim()) {
      throw new Error('Player ID is required');
    }

    if (props.initialBalance.isNegative()) {
      throw new Error('Initial balance cannot be negative');
    }

    const createdAt = props.createdAt ?? new Date();

    Wallet.assertValidDate(createdAt);

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance,
      1,
      createdAt,
      createdAt,
    );
  }

  static rehydrate(props: RehydrateWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.balance,
      props.version,
      props.createdAt,
      props.updatedAt,
    );
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  get updatedAt(): Date {
    return new Date(this.currentUpdatedAt);
  }

  credit(amount: Money, occurredAt: Date): void {
    Wallet.assertValidDate(occurredAt);
    Wallet.assertPositiveAmount(amount);

    const newBalance = this.currentBalance.add(amount);

    this.currentBalance = newBalance;
    this.currentVersion += 1;
    this.currentUpdatedAt = new Date(occurredAt);
  }

  debit(amount: Money, occurredAt: Date): void {
    Wallet.assertValidDate(occurredAt);
    Wallet.assertPositiveAmount(amount);

    const newBalance = this.currentBalance.subtract(amount);

    if (newBalance.isNegative()) {
      throw new Error('Insufficient wallet balance');
    }

    this.currentBalance = newBalance;
    this.currentVersion += 1;
    this.currentUpdatedAt = new Date(occurredAt);
  }

  private static assertPositiveAmount(amount: Money): void {
    if (!amount.isPositive()) {
      throw new Error('Amount must be positive');
    }
  }

  private static assertValidDate(date: Date): void {
    if (
      !(date instanceof Date) ||
      Number.isNaN(date.getTime())
    ) {
      throw new Error('Invalid date');
    }
  }
}
