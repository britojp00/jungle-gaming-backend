
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
  ReferenceCriteria,
  ReferenceResolution,
  resolveConcurrentDuplicate,
  resolveReference,
  toProcessResult,
  toTransactionEntity,
  validateRequiredStrings,
  WagerProcessResult,
} from '../process-support.js';

export interface ProcessWinInput {
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  /**
   * Obrigatórios (README 6.3 + §3 + §9/§10), como na BET.
   */
  roundId: string;
  gameId: string;
  /**
   * Opcional (README §7, tabela: a WIN "pode referenciar a BET da mesma
   * rodada"). Presente mas em branco é payload inválido
   * (`INVALID_REFERENCEEXTERNALTRANSACTIONID`); ausente é a rota de crédito
   * imediato da política documentada em `ARCHITECTURE.md`.
   */
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

/** Mesmo resultado da BET (README §9) — ver `../process-support.ts`. */
export type ProcessWinResult = WagerProcessResult;

/**
 * Aplica uma `WIN` (crédito) sobre a wallet travada, com a política de
 * referência do `ARCHITECTURE.md` e as mesmas garantias da `ProcessBetUseCase`
 * (README §8: a unidade de concorrência é a walletId; §11: transação, saldo,
 * ledger e outbox na mesma transação SQL).
 *
 * Sequência de idempotência: validação de payload e `Money` ANTES do lock,
 * depois lock da wallet, depois rechecagem da chave — o replay devolve o
 * resultado original **sem** resolver referência (a resolução de uma linha
 * pendente é tarefa do worker de §7.1, não da reentrada).
 *
 * A resolução em si é compartilhada com o worker por `resolveReference`, em
 * `../process-support.ts`.
 */
export class ProcessWinUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessWinInput): Promise<ProcessWinResult> {
    // Payload inválido falha ANTES de qualquer acesso ao banco (README §9).
    validateRequiredStrings({
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      roundId: input.roundId,
      gameId: input.gameId,
    });

    // A referência é validada apenas quando presente: ausência é a rota
    // legal de "WIN sem referência"; `undefined` não é erro.
    if (input.referenceExternalTransactionId !== undefined) {
      validateRequiredStrings({
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      });
    }

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new Error('WIN amount must be positive');
    }

    const payloadHash = hashWagerPayload({
      kind: WagerTransactionKind.WIN,
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      amount: input.amount,
      currency: input.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      // Normalizado para `null`: ausência e `undefined` produzem o mesmo
      // digest (ver `application/wagering/payload-hash.ts`).
      referenceExternalTransactionId:
        input.referenceExternalTransactionId ?? null,
    });

    const now = new Date();

    // A WIN nasce no domínio (README 6.3): `createWin` valida campos
    // obrigatórios, limites de coluna, formato do hash, valor positivo e a
    // política de referência ANTES de tocar o banco.
    const win = WagerTransaction.createWin({
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
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    return this.em.transactional(async (txEm) => {
      const walletRepository = new WalletRepository(txEm);

      // Lock da wallet ANTES da idempotência: as duas rotas (crédito e
      // aceite pendente) serializam aqui, como na BET (README §8).
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

        // Regra 7: replay devolve o resultado original observado — inclusive
        // se ainda estiver `PENDING_REFERENCE`, **sem** tentar resolver.
        return toProcessResult(existing, true);
      }

      const criteria: ReferenceCriteria = {
        providerId: input.providerId,
        playerId: input.playerId,
        currency: input.currency,
        roundId: input.roundId,
        walletId: input.walletId,
      };

      const reference = win.referenceExternalTransactionId;
      const resolution: ReferenceResolution = reference
        ? await resolveReference(txEm, criteria, reference, win.id)
        : { outcome: 'credit', targetId: undefined };

      if (resolution.outcome === 'pending') {
        // Regra 8: referência ausente → `PENDING_REFERENCE`, sem saldo e
        // sem lançamento, com o evento da §11 na mesma transação SQL.
        win.markPendingReference();

        const transaction = toTransactionEntity(win, wallet, txEm);
        txEm.persist(transaction);

        // Payload aprovado em reunião de projeto ("Opção A" — registrado em
        // `ARCHITECTURE.md`): envelope da §11 com `data` sem `balance` nem
        // `walletVersion`, porque nada foi aplicado (§11: `WalletBalanceChanged`
        // só quando o saldo muda).
        persistOutboxEvent(txEm, {
          eventId: randomUUID(),
          aggregateId: transaction.id,
          correlationId: input.correlationId ?? transaction.id,
          occurredAt: now.toISOString(),
          eventType: 'WagerTransactionPendingReference',
          version: 1,
          data: {
            transactionId: transaction.id,
            playerId: input.playerId,
            walletId: input.walletId,
            kind: transaction.kind,
            status: transaction.status,
            amount: amount.toJSON(),
            referenceExternalTransactionId: reference,
          },
        }, now);

        await txEm.flush();

        return toProcessResult(transaction, false);
      }

      if (resolution.outcome === 'mismatch') {
        // Regra 2: divergência de identidade não se corrige esperando —
        // `REJECTED` + `REFERENCE_MISMATCH`, auditável e sem efeito de saldo
        // (regra 6).
        win.reject(FailureCode.REFERENCE_MISMATCH);

        const transaction = toTransactionEntity(win, wallet, txEm);
        txEm.persist(transaction);

        persistOutboxEvent(txEm, {
          eventId: randomUUID(),
          aggregateId: transaction.id,
          correlationId: input.correlationId ?? transaction.id,
          occurredAt: now.toISOString(),
          eventType: 'WagerTransactionRejected',
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
            failureCode: FailureCode.REFERENCE_MISMATCH,
          },
        }, now);

        await txEm.flush();

        return toProcessResult(transaction, false);
      }

      // Crédito: sem referência, ou com referência resolvida (regra 2).
      const balanceBefore = wallet.balance;
      wallet.credit(amount, now);
      await walletRepository.save(wallet);

      // PENDING → PROCESSED guardando a FK interna da referência resolvida
      // (undefined quando a WIN não declara referência).
      win.markProcessed(resolution.targetId, now);

      const transaction = toTransactionEntity(win, wallet, txEm);
      txEm.persist(transaction);

      const ledger = new WalletLedgerEntryEntity();
      ledger.id = randomUUID();
      ledger.wallet = txEm.getReference(WalletEntity, input.walletId);
      ledger.transaction = transaction;
      ledger.direction = LedgerDirection.CREDIT;
      ledger.amount = amount.toJSON().amount;
      ledger.balanceBefore = balanceBefore.toJSON().amount;
      ledger.balanceAfter = wallet.balance.toJSON().amount;
      ledger.currency = amount.currency;
      ledger.createdAt = now;

      txEm.persist(ledger);

      persistOutboxEvent(txEm, {
        eventId: randomUUID(),
        aggregateId: transaction.id,
        correlationId: input.correlationId ?? transaction.id,
        occurredAt: now.toISOString(),
        eventType: 'WagerTransactionProcessed',
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
        },
      }, now);

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
          // Reflete o lançamento CREDIT criado acima para esta WIN.
          direction: LedgerDirection.CREDIT,
          money: amount.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
      }, now);

      // Flushes all pending changes inside the same SQL transaction.
      await txEm.flush();

      return toProcessResult(transaction, false);
    }).catch(async (error) => {
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
