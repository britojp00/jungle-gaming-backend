import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  parseWagerTransactionRequested,
  WagerTransactionRequested,
} from '../application/messaging/wager-transaction-requested.js';
import {
  ProcessBetInput,
  ProcessBetUseCase,
} from '../application/wagering/use-cases/process-bet.use-case.js';
import {
  ProcessLossInput,
  ProcessLossUseCase,
} from '../application/wagering/use-cases/process-loss.use-case.js';
import {
  ProcessReversalInput,
  ProcessReversalUseCase,
} from '../application/wagering/use-cases/process-reversal.use-case.js';
import {
  ProcessWinInput,
  ProcessWinUseCase,
} from '../application/wagering/use-cases/process-win.use-case.js';
import { WagerProcessResult } from '../application/wagering/process-support.js';
import { WagerTransactionKind } from '../domain/wagering/wager-transaction.js';
import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WagerTransactionRepository } from '../infrastructure/persistence/repositories/wager-transaction.repository.js';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

function transactionView(entity: WagerTransactionEntity): Record<string, unknown> {
  return {
    transactionId: entity.id,
    status: entity.status,
    kind: entity.kind,
    money: { amount: entity.amount, currency: entity.currency },
    walletId: entity.wallet.id,
    playerId: entity.playerId,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    roundId: entity.roundId,
    gameId: entity.gameId,
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    referenceTransactionId: entity.referenceTransaction?.id ?? null,
    failureCode: entity.rejectionReason,
    balance:
      entity.resultBalanceAmount === null
        ? null
        : {
            amount: entity.resultBalanceAmount,
            currency: entity.resultBalanceCurrency,
          },
    walletVersion: entity.resultWalletVersion,
    createdAt: entity.createdAt.toISOString(),
    processedAt: entity.processedAt?.toISOString() ?? null,
  };
}

/**
 * Submissão e consulta de transações (README §9).
 *
 * O `Idempotency-Key` do header é a fonte da verdade (§9); o corpo é o mesmo
 * comando que a fila recebe (§10), então a validação é a mesma e os casos de
 * uso financeiros são **os mesmos** dos dois canais.
 */
@Controller()
export class WageringController {
  constructor(private readonly em: EntityManager) {}

  @Post('wagering/transactions')
  async submit(
    @Res({ passthrough: true }) res: Response,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new Error('Idempotency-Key header is required');
    }

    // Valida o payload com o MESMO contrato da fila (§10) — o header entra
    // como a chave de idempotência (§9).
    const { data } = parseWagerTransactionRequested({
      messageId: idempotencyKey,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        ...(body as Record<string, unknown>),
        idempotencyKey,
      },
    });

    const base = {
      walletId: data.walletId,
      playerId: data.playerId,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey,
      amount: data.money.amount,
      currency: data.money.currency,
      roundId: data.roundId,
      gameId: data.gameId,
    };

    const result = await this.dispatch(data, base);

    // README §9: o status distingue aceite com processamento pendente (202),
    // rejeição por regra de negócio (422), conflito de reversão já aplicada
    // (409) e sucesso (200) — sempre igual em qualquer endpoint.
    res.status(
      result.failureCode === 'REFERENCE_ALREADY_REVERSED'
        ? HttpStatus.CONFLICT
        : result.status === 'PENDING_REFERENCE'
          ? HttpStatus.ACCEPTED
          : result.status === 'REJECTED'
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.OK,
    );

    // `{ transactionId, status, balance, idempotentReplay }` — `failureCode`
    // acompanha rejeições (§7.2).
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.replayed,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }

  /** Um caso de uso por `kind` (README §7) — sem regra financeira aqui. */
  private dispatch(
    data: WagerTransactionRequested['data'],
    base: Record<string, string>,
  ): Promise<WagerProcessResult> {
    if (data.kind === WagerTransactionKind.BET) {
      return new ProcessBetUseCase(this.em).execute(
        base as unknown as ProcessBetInput,
      );
    }

    if (data.kind === WagerTransactionKind.LOSS) {
      return new ProcessLossUseCase(this.em).execute(
        base as unknown as ProcessLossInput,
      );
    }

    if (
      data.kind === WagerTransactionKind.REFUND ||
      data.kind === WagerTransactionKind.ROLLBACK
    ) {
      return new ProcessReversalUseCase(this.em).execute({
        ...(base as unknown as Omit<
          ProcessReversalInput,
          'kind' | 'referenceExternalTransactionId'
        >),
        kind: data.kind,
        referenceExternalTransactionId: data.referenceExternalTransactionId!,
      });
    }

    return new ProcessWinUseCase(this.em).execute({
      ...(base as unknown as ProcessWinInput),
      ...(data.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              data.referenceExternalTransactionId,
          }
        : {}),
    });
  }

  @Get('wagering/transactions/:transactionId')
  async get(
    @Param('transactionId') transactionId: string,
  ): Promise<Record<string, unknown>> {
    const entity = await new WagerTransactionRepository(this.em).findById(
      transactionId,
    );

    if (!entity) {
      throw new Error('TRANSACTION_NOT_FOUND');
    }

    return transactionView(entity);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    const entity = await new WagerTransactionRepository(
      this.em,
    ).findByExternalTransactionId(providerId, externalTransactionId);

    if (!entity) {
      throw new Error('TRANSACTION_NOT_FOUND');
    }

    return transactionView(entity);
  }
}
