import { randomUUID } from 'node:crypto';
import {
  EntityManager,
  LockMode,
} from '@mikro-orm/postgresql';

import { Money } from '../../../domain/shared/value-objects/money.js';
import { Wallet } from '../../../domain/wallets/wallet.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });

    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, {
      playerId,
      currency,
    });

    return entity ? this.toDomain(entity) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return entity ? this.toDomain(entity) : null;
  }

  async create(
    playerId: string,
    initialBalance: Money,
  ): Promise<Wallet> {
    const now = new Date();

    const wallet = Wallet.create({
      id: randomUUID(),
      playerId,
      initialBalance,
      createdAt: now,
    });

    const entity = this.em.create(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.balance.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    this.em.persist(entity);
    await this.em.flush();

    return wallet;
  }

  async save(wallet: Wallet): Promise<void> {
    const entity = await this.em.findOne(WalletEntity, {
      id: wallet.id,
    });

    if (!entity) {
      throw new Error(`Wallet not found: ${wallet.id}`);
    }

    entity.balance = wallet.balance.toJSON().amount;
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;

    await this.em.flush();
  }

  private toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}