import { Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { Money, MoneyProps } from '../../../domain/shared/value-objects/money.js';
import {
  LedgerDirection,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import { WalletLedgerRepository } from '../../../infrastructure/persistence/repositories/wallet-ledger.repository.js';

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconciliação saldo ⇄ ledger (README §9).
 *
 * `calculatedBalance` é o saldo **reconstruído a partir dos lançamentos** —
 * o mesmo invariante que a suíte confere em todos os cenários (§13:
 * `wallet.balance == saldo reconstruído pelo ledger`). Divergência **não** é
 * corrigida aqui: é logada e sinalizada na resposta (§9).
 */
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new Error('WALLET_NOT_FOUND');
    }

    const entries = await new WalletLedgerRepository(this.em).findByWalletId(
      walletId,
    );

    let calculated = Money.zero(wallet.currency);

    for (const entry of entries) {
      const amount = Money.from({
        amount: entry.amount,
        currency: entry.currency,
      });

      calculated =
        entry.direction === LedgerDirection.CREDIT
          ? calculated.add(amount)
          : calculated.subtract(amount);
    }

    const stored = Money.from({
      amount: wallet.balance,
      currency: wallet.currency,
    });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      // §9: divergência não é corrigida silenciosamente — é logada e
      // sinalizada na resposta. Métrica continua pendente (§12).
      this.logger.warn(
        `reconciliação divergente da wallet ${walletId}: ` +
          `armazenado ${stored.toString()} x ledger ${calculated.toString()}`,
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: entries.length,
    };
  }
}
