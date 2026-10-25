import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../application/wallets/use-cases/open-wallet.use-case.js';
import {
  ReconcileWalletResult,
  ReconcileWalletUseCase,
} from '../application/wallets/use-cases/reconcile-wallet.use-case.js';
import { validateRequiredStrings } from '../application/wagering/process-support.js';
import { Money } from '../domain/shared/value-objects/money.js';
import { WalletLedgerEntryEntity } from '../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../infrastructure/persistence/entities/wallet.entity.js';
import { WalletLedgerRepository } from '../infrastructure/persistence/repositories/wallet-ledger.repository.js';

interface LedgerCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(entry: WalletLedgerEntryEntity): string {
  return Buffer.from(
    `${entry.createdAt.toISOString()}|${entry.id}`,
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): LedgerCursor {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');

  if (separator < 0) {
    throw new Error('INVALID_CURSOR');
  }

  return {
    createdAt: new Date(decoded.slice(0, separator)),
    id: decoded.slice(separator + 1),
  };
}

function entryView(entry: WalletLedgerEntryEntity) {
  return {
    id: entry.id,
    walletId: entry.wallet.id,
    transactionId: entry.transaction.id,
    direction: entry.direction,
    money: { amount: entry.amount, currency: entry.currency },
    balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
    balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Carteiras e reconciliação (README §9). Toda a regra financeira está nos
 * casos de uso — aqui é só tradução HTTP (contrato, status e cursor).
 */
@Controller()
export class WalletsController {
  constructor(private readonly em: EntityManager) {}

  @Post('wallets')
  async create(
    @Body()
    body: {
      playerId?: unknown;
      initialBalance?: { amount?: unknown; currency?: unknown };
    },
  ): Promise<Record<string, unknown>> {
    validateRequiredStrings({ playerId: body.playerId });

    const initialBalance = body.initialBalance ?? {};

    if (
      typeof initialBalance.amount !== 'string' ||
      typeof initialBalance.currency !== 'string'
    ) {
      throw new Error('INVALID_INITIAL_BALANCE');
    }

    const created = await new OpenWalletUseCase(this.em).execute({
      playerId: body.playerId as string,
      initialBalance: Money.from({
        amount: initialBalance.amount,
        currency: initialBalance.currency,
      }),
    });

    // README §9: `{ id, playerId, balance, version }`.
    return {
      id: created.id,
      playerId: created.playerId,
      balance: created.balance,
      version: created.version,
    };
  }

  @Get('wallets/:walletId')
  async get(@Param('walletId') walletId: string): Promise<Record<string, unknown>> {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new Error('WALLET_NOT_FOUND');
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balance, currency: wallet.currency },
      version: wallet.version,
    };
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<Record<string, unknown>> {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new Error('WALLET_NOT_FOUND');
    }

    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await new WalletLedgerRepository(this.em).findByWalletId(
      walletId,
      {
        limit: size,
        ...(cursor ? { after: decodeCursor(cursor) } : {}),
      },
    );

    // Um item a mais veio do repositório: se existir, há próxima página.
    const entries = rows.slice(0, size);
    const nextCursor =
      rows.length > size ? encodeCursor(entries[entries.length - 1]!) : null;

    return {
      entries: entries.map(entryView),
      nextCursor,
    };
  }

  /**
   * Reconciliação (README §9): divergência não é corrigida, é **sinalizada**
   * na resposta (e logada pelo caso de uso).
   */
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<ReconcileWalletResult> {
    return new ReconcileWalletUseCase(this.em).execute(walletId);
  }
}
