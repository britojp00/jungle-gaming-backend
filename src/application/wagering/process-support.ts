import { EntityManager } from '@mikro-orm/postgresql';

import { Money } from '../../domain/shared/value-objects/money.js';
import { Wallet } from '../../domain/wallets/wallet.js';
import { FailureCode } from '../../domain/wagering/failure-code.js';
import { LedgerDirection } from '../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { WagerTransactionEntity } from '../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity.js';
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from '../../infrastructure/persistence/entities/outbox-message.entity.js';

/**
 * Máquina compartilhada dos casos de uso que aplicam uma `WagerTransaction`
 * (BET, WIN e os próximos): validação de campos obrigatórios, mapeamento
 * domínio → entidade, resultado de replay, gravação de eventos na outbox e
 * resolução da corrida de idempotência.
 *
 * Extraída do `ProcessBetUseCase` para que os demais casos de uso reutilizem
 * exatamente o mesmo caminho sem duplicar lógica — o comportamento continua
 * sendo o validado pelos testes da BET.
 */

/**
 * Resultado comum de um caso de uso que aplica uma transação (README §9:
 * transação + saldo observado + `idempotentReplay`).
 */
export interface WagerProcessResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  walletVersion: number;
  replayed: boolean;
  failureCode?: string;
}

/**
 * Falha como payload inválido (README §9: a API deve distinguir "payload
 * inválido" de regra de negócio) — campo ausente ou em branco vira
 * `INVALID_<CAMPO>` antes de qualquer acesso ao banco.
 */
export function validateRequiredStrings(fields: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`INVALID_${field.toUpperCase()}`);
    }
  }
}

/**
 * Critérios da regra 2 (README §7: a referência deve pertencer ao mesmo
 * provider, player, wallet, moeda e rodada). Vêm do payload, quando o caso
 * de uso é a entrada da API, ou da própria linha persistida, quando quem
 * resolve é o worker de §7.1 — em ambos os casos são os mesmos cinco campos.
 */
export interface ReferenceCriteria {
  providerId: string;
  playerId: string;
  currency: string;
  roundId: string;
  walletId: string;
}

/**
 * Desfechos possíveis da resolução de uma referência declarada (política
 * registrada em `ARCHITECTURE.md`, aplicando as regras 2 e 8 do README §7):
 *
 * - `credit` com alvo → a referência existe e cumpre a regra 2;
 * - `credit` sem alvo (`targetId: undefined`) → não há referência declarada:
 *   crédito imediato (só a entrada da API produce este caso; o worker nunca,
 *   porque uma linha `PENDING_REFERENCE` sempre declara referência);
 * - `pending` → a referência declarada ainda não existe (regra 8);
 * - `mismatch` → a referência existe mas viola a regra 2 (outro provider,
 *   player, wallet, moeda ou rodada): `REJECTED` + `REFERENCE_MISMATCH`,
 *   que não se corrige esperando.
 */
export type ReferenceResolution =
  | { outcome: 'credit'; targetId: string }
  | { outcome: 'credit'; targetId?: undefined }
  | { outcome: 'pending' }
  | { outcome: 'mismatch' };

/**
 * Resolve a referência declarada (README §7, regra 2), sempre DENTRO da
 * transação que já segura o lock da wallet.
 *
 * As consultas são por coluna/filtro de PK (`externalTransactionId`,
 * `id`, `wallet`) — nunca pela relação não populada da entidade lida —
 * porque `referenceTransaction`/`wallet` são `ManyToOne` sem eager load.
 *
 * Ordem: (providerId, referenceExternalTransactionId) → sem linha, o
 * mesmo `externalTransactionId` em OUTRO provider é `REFERENCE_MISMATCH`
 * (a chave composta não bateu) e nenhuma linha é a "referência
 * inexistente" da regra 8; com linha, conferem-se player, moeda, rodada e
 * wallet. Qualquer divergência é `mismatch`.
 *
 * `excludeId` é o id da transação que está sendo resolvida: a referência
 * aponta para OUTRA transação (§7, regra 2 e a tabela — a `WIN` referencia a
 * `BET` da mesma rodada), então a própria linha nunca é alvo. Se o
 * `referenceExternalTransactionId` for igual ao `externalTransactionId`
 * dela, não há alvo a encontrar — e como `(provider_id,
 * external_transaction_id)` é único, nunca haverá outro que a resolva: é
 * **referência ausente** (regra 8), que a §7.1 reprocessa e termina com
 * `REFERENCE_NOT_FOUND`, nunca um crédito para si mesma.
 *
 * A ordem importa para o worker: as consultas rodam DENTRO da transação e
 * depois do lock, com snapshot do `READ COMMITTED` — é por isso que uma BET
 * que chegue depois é enxergada aqui, e não na seleção da fila.
 */
export async function resolveReference(
  txEm: EntityManager,
  criteria: ReferenceCriteria,
  reference: string,
  excludeId: string,
): Promise<ReferenceResolution> {
  const byProvider = await txEm.findOne(WagerTransactionEntity, {
    providerId: criteria.providerId,
    externalTransactionId: reference,
  });

  const target =
    byProvider && byProvider.id !== excludeId ? byProvider : null;

  if (!target) {
    const anywhere = await txEm.findOne(WagerTransactionEntity, {
      externalTransactionId: reference,
    });

    return anywhere && anywhere.id !== excludeId
      ? { outcome: 'mismatch' }
      : { outcome: 'pending' };
  }

  if (target.playerId !== criteria.playerId) {
    return { outcome: 'mismatch' };
  }

  if (target.currency !== criteria.currency) {
    return { outcome: 'mismatch' };
  }

  if (target.roundId !== criteria.roundId) {
    return { outcome: 'mismatch' };
  }

  // Mesma wallet: filtro pelo PK da relação `wallet`, como faria o
  // MikroORM (`{ wallet: id }`), sem depender do objeto referência.
  const sameWallet = await txEm.findOne(WagerTransactionEntity, {
    id: target.id,
    wallet: criteria.walletId,
  });

  if (!sameWallet) {
    return { outcome: 'mismatch' };
  }

  return { outcome: 'credit', targetId: target.id };
}

/**
 * Estado MUTÁVEL de uma transação aplicado a uma entidade: status, FK da
 * referência resolvida, código de falha, `processed_at` e o saldo/versão
 * observados no momento da conclusão (§7, regra 7 — o replay devolve o
 * resultado original).
 *
 * É o único ponto em que uma linha `PENDING_REFERENCE` passa a registrar o
 * resultado terminal: o worker de §7.1 chama-o sobre a entidade que já
 * existe, e `toTransactionEntity` chama-o sobre a recém-criada — os dois
 * caminhos persistem o mesmo conjunto de campos.
 */
export function applyTransactionState(
  entity: WagerTransactionEntity,
  domainTransaction: WagerTransaction,
  wallet: Wallet,
  em: EntityManager,
): WagerTransactionEntity {
  entity.status = domainTransaction.status;
  entity.referenceTransaction = domainTransaction.referenceTransactionId
    ? em.getReference(
        WagerTransactionEntity,
        domainTransaction.referenceTransactionId,
      )
    : null;
  entity.rejectionReason = domainTransaction.failureCode;
  entity.resultBalanceAmount = wallet.balance.toJSON().amount;
  entity.resultBalanceCurrency = wallet.balance.currency;
  entity.resultWalletVersion = wallet.version;
  entity.processedAt = domainTransaction.processedAt;

  return entity;
}

/**
 * Mapeia o `WagerTransaction` de domínio para a entidade persistida, no
 * mesmo formato do registro de abertura em `OpenWalletUseCase`: todo estado
 * da transação vem do domínio (kind, status, hash, rodada, jogo, referência,
 * código de falha, `processedAt`); saldo e versão resultantes são estado de
 * persistência do caso de uso (README §7, regra 7 — o replay devolve o
 * resultado observado naquele momento).
 *
 * `processedAt` é preenchido apenas por `markProcessed`: `reject(code)`,
 * no esqueleto oficial, não recebe data — transação rejeitada não foi
 * aplicada, então a coluna permanece nula.
 */
export function toTransactionEntity(
  domainTransaction: WagerTransaction,
  wallet: Wallet,
  em: EntityManager,
): WagerTransactionEntity {
  const entity = new WagerTransactionEntity();
  entity.id = domainTransaction.id;
  entity.wallet = em.getReference(WalletEntity, domainTransaction.walletId);
  entity.playerId = domainTransaction.playerId;
  entity.providerId = domainTransaction.providerId;
  entity.externalTransactionId = domainTransaction.externalTransactionId;
  entity.idempotencyKey = domainTransaction.idempotencyKey;
  entity.payloadHash = domainTransaction.payloadHash;
  entity.roundId = domainTransaction.roundId;
  entity.gameId = domainTransaction.gameId;
  entity.kind = domainTransaction.kind;
  entity.amount = domainTransaction.money.toJSON().amount;
  entity.currency = domainTransaction.money.currency;
  entity.referenceExternalTransactionId =
    domainTransaction.referenceExternalTransactionId;
  entity.createdAt = domainTransaction.createdAt;
  entity.updatedAt = domainTransaction.createdAt;

  return applyTransactionState(entity, domainTransaction, wallet, em);
}

/**
 * Resultado a partir da entidade persistida — é o que o replay devolve
 * (README §7, regra 7), inclusive para transações ainda `PENDING_REFERENCE`.
 */
export function toProcessResult(
  transaction: WagerTransactionEntity,
  replayed: boolean,
): WagerProcessResult {
  if (
    transaction.resultBalanceAmount === null ||
    transaction.resultBalanceCurrency === null ||
    transaction.resultWalletVersion === null
  ) {
    throw new Error('TRANSACTION_RESULT_NOT_AVAILABLE');
  }

  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: {
      amount: transaction.resultBalanceAmount,
      currency: transaction.resultBalanceCurrency,
    },
    walletVersion: transaction.resultWalletVersion,
    replayed,
    ...(transaction.rejectionReason
      ? { failureCode: transaction.rejectionReason }
      : {}),
  };
}

/**
 * Grava o evento na outbox dentro da MESMA transação SQL da operação
 * financeira (README §11: nada é publicado antes do commit).
 */
export function persistOutboxEvent(
  em: EntityManager,
  payload: Record<string, unknown>,
  occurredAt: Date,
): void {
  const event = new OutboxMessageEntity();
  event.id = payload.eventId as string;
  event.eventType = payload.eventType as string;
  event.aggregateId = payload.aggregateId as string;
  event.payload = payload;
  event.status = OutboxMessageStatus.PENDING;
  event.attempts = 0;
  event.nextAttemptAt = occurredAt;
  event.occurredAt = occurredAt;
  event.createdAt = occurredAt;

  em.persist(event);
}

/**
 * Resolve a corrida de idempotência entre requisições que usam a mesma
 * `(providerId, idempotencyKey)` em wallets diferentes: elas não se
 * serializam no lock da carteira (a unidade de concorrência é a walletId),
 * então ambas passam pela pré-checagem `findOne` e chegam ao INSERT — quem
 * perde viola a unique `wager_transactions_provider_idempotency_unique`.
 *
 * A violação só ocorre quando a transação concorrente já confirmou (a
 * unique faz o INSERT esperar o commit/rollback do par), então reler a
 * chave fora da transação abortada devolve o resultado real:
 * - hash igual → replay do resultado original;
 * - hash diferente → conflito de idempotência (README 9);
 * - sem linha → não era a constraint de idempotência (ex.:
 *   `external_transaction_id`); o erro original é propagado sem máscara.
 */
export async function resolveConcurrentDuplicate<T>(
  em: EntityManager,
  key: { providerId: string; idempotencyKey: string },
  payloadHash: string,
  originalError: unknown,
  toResult: (entity: WagerTransactionEntity, replayed: boolean) => T,
): Promise<T> {
  const existing = await em.findOne(WagerTransactionEntity, key);

  if (!existing) {
    throw originalError;
  }

  if (existing.payloadHash !== payloadHash) {
    throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
  }

  return toResult(existing, true);
}

export type ReversalEvaluation =
  | { outcome: 'apply'; direction: LedgerDirection }
  | { outcome: 'reject'; failureCode: FailureCode };

/**
 * Reconstrói o domínio a partir da linha persistida — o mesmo mapeamento
 * usado pela entrada e pelo worker de §7.1, para que ambos avaliem as regras
 * sobre o MESMO objeto.
 */
export function toDomainTransaction(
  entity: WagerTransactionEntity,
  walletId: string,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    walletId,
    playerId: entity.playerId,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: Money.from({ amount: entity.amount, currency: entity.currency }),
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    referenceTransactionId: entity.referenceTransaction?.id ?? null,
    createdAt: entity.createdAt,
    status: entity.status,
    failureCode: entity.rejectionReason as FailureCode | null,
    processedAt: entity.processedAt,
  });
}

/**
 * Regras das reversões (README §7, regras 3, 4, 5 e 9) sobre uma referência
 * já resolvida.
 *
 * É o MESMO julgamento para quem entra pela API/fila e para o worker de
 * §7.1: uma reversão `PENDING_REFERENCE` resolvida depois tem de seguir as
 * regras aplicadas na entrada — caso contrário, o worker creditaria algo que
 * deveria debitar ou aplicaria valor/kind que a regra 5 e a regra 3 recusam.
 */
export function evaluateReversal(input: {
  reversal: WagerTransaction;
  target: WagerTransaction;
  amount: Money;
  walletBalance: Money;
  alreadyReversed: boolean;
}): ReversalEvaluation {
  // Regra 3: `REFUND` só reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou
  // `REFUND`. O domínio recusa os demais kinds e decide a direção.
  let direction: LedgerDirection;

  try {
    direction = input.reversal.ledgerDirectionFor(input.target);
  } catch {
    return {
      outcome: 'reject',
      failureCode: FailureCode.REFERENCE_MISMATCH,
    };
  }

  // Regra 5: o valor é igual ao da referência.
  if (!input.amount.equals(input.target.money)) {
    return {
      outcome: 'reject',
      failureCode: FailureCode.REFERENCE_AMOUNT_MISMATCH,
    };
  }

  // Regra 4: uma referência não é revertida duas vezes pelo mesmo tipo.
  if (input.alreadyReversed) {
    return {
      outcome: 'reject',
      failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
    };
  }

  // Regra 9: reversão que negativaria o saldo tem failureCode distinto do
  // de aposta sem saldo.
  if (
    direction === LedgerDirection.DEBIT &&
    input.walletBalance.subtract(input.amount).isNegative()
  ) {
    return {
      outcome: 'reject',
      failureCode: FailureCode.INSUFFICIENT_BALANCE_FOR_REVERSAL,
    };
  }

  return { outcome: 'apply', direction };
}
