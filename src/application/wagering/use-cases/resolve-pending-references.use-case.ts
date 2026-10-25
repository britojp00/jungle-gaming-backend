import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';

import { Money } from '../../../domain/shared/value-objects/money.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';
import { Wallet } from '../../../domain/wallets/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntryEntity,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import {
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '../../../infrastructure/persistence/repositories/wager-transaction.repository.js';
import { WalletRepository } from '../../../infrastructure/persistence/repositories/wallet.repository.js';
import {
  applyTransactionState,
  evaluateReversal,
  persistOutboxEvent,
  ReferenceCriteria,
  resolveReference,
  toDomainTransaction,
} from '../process-support.js';
import {
  nextReferenceAttemptAt,
  shouldRejectMissingReference,
} from '../reference-retry-policy.js';

/** Linhas por tick: o suficiente para drenar uma fila normal num ciclo. */
export const DEFAULT_PENDING_REFERENCE_CLAIM_LIMIT = 20;

export interface ResolvePendingReferencesOptions {
  /** Tamanho do lote do claim. */
  limit?: number;
  /**
   * Relógio do ciclo. Toda decisão de backoff, TTL e elegibilidade usa ESTE
   * instante — nunca `Date.now()` escondido — para que os testes sejam
   * determinísticos e todas as instâncias enxerguem a mesma janela.
   */
  now?: Date;
}

export type PendingReferenceOutcome =
  /** referência resolvida e WIN creditada */
  | 'resolved'
  /** rejeição terminal: `REFERENCE_MISMATCH` ou `REFERENCE_NOT_FOUND` */
  | 'rejected'
  /** estado persistido irresolúvel → `FAILED` + `INTERNAL_ERROR` + log */
  | 'inconsistent'
  /** referência ainda ausente dentro do orçamento → segue pendente */
  | 'stillPending'
  /** outra instância já concluiu a linha entre o claim e o lock */
  | 'skipped';

export type PendingReferenceProblemReason =
  | 'UNRESOLVABLE_STATE'
  | 'PROCESSING_FAILED';

/**
 * Problema estruturado devolvido pelo ciclo (e logado pelo worker). Nunca
 * contém valores monetários: só identificadores e o motivo.
 */
export interface PendingReferenceProblem {
  reason: PendingReferenceProblemReason;
  transactionId: string;
  walletId: string;
  kind?: WagerTransactionKind;
  /**
   * Campo ou vínculo que torna a linha irresolúvel, quando
   * `reason = UNRESOLVABLE_STATE` (`reference_external_transaction_id`,
   * `provider_id`, `round_id`, `player_id` ou `currency`).
   */
  missing?: string;
  /** Mensagem do erro, quando `reason = PROCESSING_FAILED`. */
  detail?: string;
}

export interface ResolvePendingReferencesResult {
  /** Linhas selecionadas pelo claim (com a tentativa já contada). */
  claimed: number;
  resolved: number;
  rejected: number;
  inconsistent: number;
  stillPending: number;
  skipped: number;
  problems: PendingReferenceProblem[];
}

interface ApplyOutcome {
  outcome: PendingReferenceOutcome;
  missing?: string;
}

/**
 * Critérios da regra 2 aplicados sobre a LINHA PERSISTIDA, ou o campo que
 * impede a resolução.
 *
 * Um `PENDING_REFERENCE` SEM referência declarada não é "referência
 * inexistente": não há o que procurar e nada no sistema volta a gravar
 * `reference_external_transaction_id` depois da inserção — a linha é, por
 * construção, irrecoverável. Idem para provider e rodada, sem os quais a
 * regra 2 nem sequer pode ser conferida. Essa é a distinção exigida:
 * anomalia de estado é `FAILED` + `INTERNAL_ERROR`, nunca
 * `REFERENCE_NOT_FOUND`.
 */
export function pendingReferenceCriteria(
  entity: WagerTransactionEntity,
  walletId: string,
): { criteria: ReferenceCriteria; reference: string } | { missing: string } {
  if (!entity.referenceExternalTransactionId) {
    return { missing: 'reference_external_transaction_id' };
  }

  if (!entity.providerId) {
    return { missing: 'provider_id' };
  }

  if (!entity.roundId) {
    return { missing: 'round_id' };
  }

  return {
    criteria: {
      providerId: entity.providerId,
      playerId: entity.playerId,
      currency: entity.currency,
      roundId: entity.roundId,
      walletId,
    },
    reference: entity.referenceExternalTransactionId,
  };
}

/**
 * Worker de §7.1 — recupera linhas `PENDING_REFERENCE` com backoff
 * exponencial, limite de tentativas e TTL absoluto.
 *
 * Ciclo (README §7.1, §8 e §11):
 *
 * 1. **claim** numa transação curta: `SELECT … WHERE status =
 *    'PENDING_REFERENCE' AND reference_next_attempt_at <= now ORDER BY …
 *    LIMIT n FOR UPDATE SKIP LOCKED`, incremento da tentativa e gravação da
 *    próxima janela — tudo antes de liberar a linha;
 * 2. **uma transação financeira por linha**: lock da wallet, RELEITURA da
 *    linha (se outra instância já a concluiu, pula), resolução da referência
 *    e, no mesmo commit, saldo + ledger + transação + outbox.
 *
 * Por que não duplica crédito entre instâncias: `SKIP LOCKED` evita a
 * disputa, o lock da wallet serializa as decisões, a releitura feita DEPOIS
 * do lock enxerga o commit da outra instância (READ COMMITTED), e a unique
 * `(wallet_id, transaction_id)` do ledger derruba a transação inteira se
 * mesmo assim houver duas — três camadas, nenhuma dependente de SQS.
 *
 * O replay de uma linha ainda pendente continua não a resolvendo
 * (`ProcessWinUseCase`): reprocessar é exclusivamente deste worker.
 */
export class ResolvePendingReferencesUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    options: ResolvePendingReferencesOptions = {},
  ): Promise<ResolvePendingReferencesResult> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? DEFAULT_PENDING_REFERENCE_CLAIM_LIMIT;

    const claimed = await this.claim(limit, now);

    const result: ResolvePendingReferencesResult = {
      claimed: claimed.length,
      resolved: 0,
      rejected: 0,
      inconsistent: 0,
      stillPending: 0,
      skipped: 0,
      problems: [],
    };

    // Falha em UMA linha não aborta o lote: a tentativa já foi contada e a
    // janela gravada, então a linha volta a ser elegível sozinha; o problema
    // é reportado sem payload financeiro. Erros do claim (ex.: banco fora do
    // ar) NÃO são capturados aqui: propagam para o worker tentar no ciclo
    // seguinte, sem alterar estado nenhum.
    for (const row of claimed) {
      try {
        const { outcome, missing } = await this.applyRow(row, now);

        if (outcome === 'resolved') {
          result.resolved += 1;
        } else if (outcome === 'rejected') {
          result.rejected += 1;
        } else if (outcome === 'inconsistent') {
          result.inconsistent += 1;
          result.problems.push({
            reason: 'UNRESOLVABLE_STATE',
            transactionId: row.id,
            walletId: row.walletId,
            missing,
          });
        } else if (outcome === 'stillPending') {
          result.stillPending += 1;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        result.problems.push({
          reason: 'PROCESSING_FAILED',
          transactionId: row.id,
          walletId: row.walletId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  /**
   * Claim atômico: seleciona, contabiliza a tentativa e agenda a próxima
   * janela numa única transação. `em.execute` participa da transação
   * corrente do EntityManager, então a trava `FOR UPDATE` só é liberada
   * depois que a janela estiver gravada.
   */
  private async claim(
    limit: number,
    now: Date,
  ): Promise<PendingReferenceClaim[]> {
    return this.em.transactional(async (txEm) => {
      const repository = new WagerTransactionRepository(txEm);
      const rows = await repository.claimPendingReferences(limit, now);

      for (const row of rows) {
        const attempts = row.referenceAttempts + 1;
        const nextAttemptAt = nextReferenceAttemptAt({
          attempts,
          now,
          createdAt: row.createdAt,
        });

        await repository.recordReferenceAttempt(
          row.id,
          attempts,
          nextAttemptAt,
        );
      }

      return rows;
    });
  }

  /**
   * Aplica uma linha selecionada, na sua própria transação SQL.
   *
   * Ordem deliberada: lock da wallet ANTES da releitura — quem chegar
   * segundo fica esperando a trava e só então lê a linha, enxergando o
   * estado já confirmado pelo par.
   */
  private async applyRow(
    row: PendingReferenceClaim,
    now: Date,
  ): Promise<ApplyOutcome> {
    return this.em.transactional(async (txEm): Promise<ApplyOutcome> => {
      const walletRepository = new WalletRepository(txEm);

      const wallet = await walletRepository.findByIdForUpdate(row.walletId);

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      const entity = await txEm.findOne(WagerTransactionEntity, { id: row.id });

      if (!entity || entity.status !== WagerTransactionStatus.PENDING_REFERENCE) {
        return { outcome: 'skipped' };
      }

      const money = Money.from({
        amount: entity.amount,
        currency: entity.currency,
      });

      const domain = WagerTransaction.rehydrate({
        id: entity.id,
        walletId: row.walletId,
        playerId: entity.playerId,
        providerId: entity.providerId,
        externalTransactionId: entity.externalTransactionId,
        idempotencyKey: entity.idempotencyKey,
        payloadHash: entity.payloadHash,
        roundId: entity.roundId,
        gameId: entity.gameId,
        kind: entity.kind,
        money,
        referenceExternalTransactionId: entity.referenceExternalTransactionId,
        referenceTransactionId: entity.referenceTransaction?.id ?? null,
        createdAt: entity.createdAt,
        status: entity.status,
        failureCode: entity.rejectionReason as FailureCode | null,
        processedAt: entity.processedAt,
      });

      // Estado persistido irrecuperável: a linha contradiz a própria wallet
      // (README §6.3: `FAILED` = erro permanente de infraestrutura, terminal
      // e auditável). `wallets.player_id` e a moeda da wallet não mudam
      // depois da abertura e são conferidos na entrada da WIN, então essa
      // divergência não se corrige esperando — o retry seria infinito.
      const brokenLink =
        wallet.playerId !== entity.playerId
          ? 'player_id'
          : wallet.balance.currency !== entity.currency
            ? 'currency'
            : null;

      if (brokenLink) {
        return this.failUnresolvable(txEm, entity, wallet, domain, brokenLink);
      }

      const inputs = pendingReferenceCriteria(entity, row.walletId);

      if ('missing' in inputs) {
        return this.failUnresolvable(
          txEm,
          entity,
          wallet,
          domain,
          inputs.missing,
        );
      }

      const { criteria, reference } = inputs;
      const resolution = await resolveReference(
        txEm,
        criteria,
        reference,
        entity.id,
      );

      if (resolution.outcome === 'mismatch') {
        // Regra 2 violada: não se corrige esperando (§7.1 só reprocessa
        // referência AUSENTE). Mesma transação: REJECTED + evento e nada de
        // saldo (§7, regra 6).
        domain.reject(FailureCode.REFERENCE_MISMATCH);
        applyTransactionState(entity, domain, wallet, txEm);
        this.persistRejectedEvent(
          txEm,
          entity,
          wallet,
          money,
          row.walletId,
          FailureCode.REFERENCE_MISMATCH,
          now,
        );
        await txEm.flush();

        return { outcome: 'rejected' };
      }

      if (resolution.outcome === 'pending') {
        // Só aqui o limite/TTL é consultado: se a referência chegou,
        // resolve-se mesmo com o TTL vencido — rejeitar descartaria uma
        // transação recuperável.
        if (
          shouldRejectMissingReference({
            attempts: entity.referenceAttempts,
            createdAt: entity.createdAt,
            now,
          })
        ) {
          domain.reject(FailureCode.REFERENCE_NOT_FOUND);
          applyTransactionState(entity, domain, wallet, txEm);
          this.persistRejectedEvent(
            txEm,
            entity,
            wallet,
            money,
            row.walletId,
            FailureCode.REFERENCE_NOT_FOUND,
            now,
          );
          await txEm.flush();

          return { outcome: 'rejected' };
        }

        // Ainda dentro do orçamento: nada muda nesta transação — a janela e
        // a tentativa já foram gravadas no claim, e o evento da §11 existe
        // na outbox desde o aceite (não se reemite a cada tentativa).
        return { outcome: 'stillPending' };
      }

      if (!resolution.targetId) {
        // Inalcançável pela política: referência declarada só resolve com
        // alvo. Estoura como PROCESSING_FAILED em vez de gravar FK nula.
        throw new Error('REFERENCE_RESOLUTION_WITHOUT_TARGET');
      }

      const balanceBefore = wallet.balance;
      let direction = LedgerDirection.CREDIT;

      if (
        domain.kind === WagerTransactionKind.REFUND ||
        domain.kind === WagerTransactionKind.ROLLBACK
      ) {
        // Reversão pendente (§7, regras 3, 4, 5 e 9): o MESMO julgamento da
        // entrada — sem isto, uma `ROLLBACK` de `WIN` resolvida aqui seria
        // creditada em vez de debitada, e um valor/kind que a regra recusa
        // seria aplicado.
        const target = await txEm.findOne(WagerTransactionEntity, {
          id: resolution.targetId,
        });
        const alreadyReversed = await txEm.findOne(WagerTransactionEntity, {
          providerId: entity.providerId!,
          referenceExternalTransactionId: entity.referenceExternalTransactionId!,
          kind: domain.kind,
          status: WagerTransactionStatus.PROCESSED,
        });

        const evaluation = evaluateReversal({
          reversal: domain,
          target: toDomainTransaction(target!, row.walletId),
          amount: money,
          walletBalance: wallet.balance,
          alreadyReversed: alreadyReversed !== null,
        });

        if (evaluation.outcome === 'reject') {
          domain.reject(evaluation.failureCode);
          applyTransactionState(entity, domain, wallet, txEm);
          this.persistRejectedEvent(
            txEm,
            entity,
            wallet,
            money,
            row.walletId,
            evaluation.failureCode,
            now,
          );
          await txEm.flush();

          return { outcome: 'rejected' };
        }

        direction = evaluation.direction;
      }

      // Aplicação (regra 2 satisfeita) — saldo, ledger, transação e outbox no
      // mesmo commit (README §11).
      if (direction === LedgerDirection.CREDIT) {
        wallet.credit(money, now);
      } else {
        wallet.debit(money, now);
      }

      await walletRepository.save(wallet);

      domain.markProcessed(resolution.targetId, now);
      applyTransactionState(entity, domain, wallet, txEm);

      const ledger = new WalletLedgerEntryEntity();
      ledger.id = randomUUID();
      ledger.wallet = txEm.getReference(WalletEntity, row.walletId);
      ledger.transaction = entity;
      ledger.direction = direction;
      ledger.amount = money.toJSON().amount;
      ledger.balanceBefore = balanceBefore.toJSON().amount;
      ledger.balanceAfter = wallet.balance.toJSON().amount;
      ledger.currency = money.currency;
      ledger.createdAt = now;

      txEm.persist(ledger);

      persistOutboxEvent(
        txEm,
        {
          eventId: randomUUID(),
          aggregateId: entity.id,
          // `correlation_id` não é coluna: o correlationId original da
          // requisição não é persistido, então o worker correlaciona pelo
          // id da transação (documentado em ARCHITECTURE.md).
          correlationId: entity.id,
          occurredAt: now.toISOString(),
          eventType: 'WagerTransactionProcessed',
          version: 1,
          data: {
            transactionId: entity.id,
            playerId: entity.playerId,
            walletId: row.walletId,
            kind: entity.kind,
            status: entity.status,
            amount: money.toJSON(),
            balance: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          },
        },
        now,
      );

      persistOutboxEvent(
        txEm,
        {
          eventId: randomUUID(),
          aggregateId: row.walletId,
          correlationId: entity.id,
          occurredAt: now.toISOString(),
          eventType: 'WalletBalanceChanged',
          version: 1,
          data: {
            walletId: row.walletId,
            transactionId: entity.id,
            direction: LedgerDirection.CREDIT,
            money: money.toJSON(),
            balanceBefore: balanceBefore.toJSON(),
            balanceAfter: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          },
        },
        now,
      );

      await txEm.flush();

      return { outcome: 'resolved' };
    });
  }

  /**
   * Estado persistido que torna a linha irrecuperável → `FAILED` +
   * `INTERNAL_ERROR` (README §6.3: erro permanente de infraestrutura,
   * terminal e auditável) na MESMA transação, e SEM evento — a §11 não
   * prevê evento para falha de infraestrutura e `WagerTransactionRejected`
   * significa rejeição por regra de negócio. O motivo estruturado
   * (`missing`) vai no resultado, para o worker registrar em log.
   */
  private async failUnresolvable(
    txEm: EntityManager,
    entity: WagerTransactionEntity,
    wallet: Wallet,
    domain: WagerTransaction,
    missing: string,
  ): Promise<ApplyOutcome> {
    domain.fail(FailureCode.INTERNAL_ERROR);
    applyTransactionState(entity, domain, wallet, txEm);
    await txEm.flush();

    return { outcome: 'inconsistent', missing };
  }

  /**
   * `WagerTransactionRejected` na mesma transação da rejeição (README §11),
   * com o shape usado pelo caso de entrada: `failureCode` distingue a
   * violação da regra 2 do esgotamento de §7.1.
   */
  private persistRejectedEvent(
    txEm: EntityManager,
    entity: WagerTransactionEntity,
    wallet: Wallet,
    money: Money,
    walletId: string,
    failureCode: FailureCode,
    now: Date,
  ): void {
    persistOutboxEvent(
      txEm,
      {
        eventId: randomUUID(),
        aggregateId: entity.id,
        correlationId: entity.id,
        occurredAt: now.toISOString(),
        eventType: 'WagerTransactionRejected',
        version: 1,
        data: {
          transactionId: entity.id,
          playerId: entity.playerId,
          walletId,
          kind: entity.kind,
          status: entity.status,
          amount: money.toJSON(),
          balance: wallet.balance.toJSON(),
          walletVersion: wallet.version,
          failureCode,
        },
      },
      now,
    );
  }
}
