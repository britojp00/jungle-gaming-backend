import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { InvalidTransactionStateError } from '../shared/errors/invalid-transaction-state-error.js';
import { Money } from '../shared/value-objects/money.js';
import { FailureCode } from './failure-code.js';

export enum WagerTransactionKind {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt?: Date;
}

/**
 * Campos comuns a toda operação de provedor (BET, WIN, LOSS, REFUND e
 * ROLLBACK). `providerId`, `externalTransactionId`, `idempotencyKey` e
 * `payloadHash` são obrigatórios pela constraint
 * `wager_transactions_external_fields_valid`; `roundId` e `gameId` pela
 * modelagem do README 6.3 + §3 ("operações associadas a uma rodada"), que
 * os tipa como não anuláveis no construtor — o schema permite NULL, mas o
 * domínio é deliberadamente mais estrito (decisão documentada em
 * `ARCHITECTURE.md`).
 */
export interface CreateExternalTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  roundId: string;
  gameId: string;
  money: Money;
  createdAt?: Date;
}

/** BET não admite referência: o campo é estruturalmente ausente. */
export interface CreateBetTransactionProps
  extends CreateExternalTransactionProps {}

/** WIN pode referenciar a BET da mesma rodada (README §7, tabela). */
export interface CreateWinTransactionProps
  extends CreateExternalTransactionProps {
  referenceExternalTransactionId?: string;
}

/** LOSS não admite referência: o campo é estruturalmente ausente. */
export interface CreateLossTransactionProps
  extends CreateExternalTransactionProps {}

/** REFUND exige referência (README §7, regra 1). */
export interface CreateRefundTransactionProps
  extends CreateExternalTransactionProps {
  referenceExternalTransactionId: string;
}

/** ROLLBACK exige referência (README §7, regra 1). */
export interface CreateRollbackTransactionProps
  extends CreateExternalTransactionProps {
  referenceExternalTransactionId: string;
}

/** Forma interna aceita pelas factories de operação de provedor. */
interface ExternalTransactionProps extends CreateExternalTransactionProps {
  referenceExternalTransactionId?: string | null;
}

export interface RehydrateWagerTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  createdAt: Date;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  processedAt: Date | null;
}

/**
 * Transação de aposta (README 6.3).
 *
 * ## Factories
 * - `createOpening` — interna (§6.3: "OPENING é interno: não pode ser
 *   submetido pela API nem pela fila"): não recebe metadados de provedor
 *   nem `roundId`/`gameId` (a §3 fala de operações **enviadas por
 *   provedores**) e nasce `PROCESSED`, junto com a wallet e o ledger na
 *   mesma transação SQL.
 * - `createBet`, `createWin`, `createLoss`, `createRefund`,
 *   `createRollback` — operações de provedor: nascem `PENDING`
 *   (README 6.3), validam campos obrigatórios, limites do schema, valor
 *   monetário e a política de referência do kind.
 *
 * ## Política de referência externa
 * - `REFUND`/`ROLLBACK`: obrigatória (§7, regra 1; constraint
 *   `wager_transactions_reversal_reference_required`);
 * - `WIN`: opcional (§7, tabela: "pode referenciar a BET da mesma rodada");
 * - `BET`/`LOSS`: proibida — nenhuma regra do README lhe atribui
 *   significado (interpretação documentada; o schema não a proíbe, mas
 *   aceitar referência sem regra seria aceitar combinação inválida).
 *
 * ## Valor monetário
 * Todos os kinds nascem com valor **estritamente positivo**: o ledger exige
 * `amount > 0` (constraint `wallet_ledger_amount_positive`) e `LOSS` é
 * informativa — não movimenta saldo nem gera lançamento (§7 e §6.4), mas
 * registrar um valor não positivo não descreveria a rodada. O schema aceita
 * `amount >= 0`; o domínio é mais estrito, como permitido pela §6.0.
 *
 * ## Transições (README 6.3)
 * ```
 * PENDING ───────────────────► PROCESSED        markProcessed(ref?, at)
 * PENDING ───────────────────► PENDING_REFERENCE markPendingReference()
 * PENDING_REFERENCE ─────────► PROCESSED        markProcessed(ref?, at)
 * PENDING_REFERENCE ─────────► PENDING_REFERENCE (no-op idempotente)
 * PENDING / PENDING_REFERENCE ► REJECTED        reject(code)
 * PENDING / PENDING_REFERENCE ► FAILED          fail(code)
 * ```
 * Qualquer transição a partir de `PROCESSED`, `REJECTED` ou `FAILED`
 * lança `InvalidTransactionStateError` (erro de programação, não de
 * negócio). `OPENING` nasce terminal: nenhuma transição lhe cabe.
 *
 * `markPendingReference` é kind-agnóstica — **quando** chamá-la é política
 * do caso de uso. A espera de uma referência fornecida mas ainda
 * inexistente num `WIN` é decisão de projeto pendente: o README não
 * resolve o caso expressamente (ver `ARCHITECTURE.md`).
 *
 * ## Perspectiva do banco
 * - `roundId`/`gameId`/`referenceTransactionId`/`failureCode` persistem nas
 *   colunas já existentes (`round_id`, `game_id`, `reference_transaction_id`
 *   e `rejection_reason`) — nenhuma migration nova é necessária.
 * - `resultBalanceAmount`/`resultWalletVersion` (colunas de replay, §7
 *   regra 7) não fazem parte do modelo de domínio, tal como no esqueleto
 *   oficial: são estado de persistência do caso de uso.
 */
export class WagerTransaction {
  private currentStatus: WagerTransactionStatus;
  private currentProcessedAt: Date | null;
  private currentReferenceTransactionId: string | null;
  private currentFailureCode: FailureCode | null;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly providerId: string | null,
    public readonly externalTransactionId: string | null,
    public readonly idempotencyKey: string | null,
    public readonly payloadHash: string | null,
    public readonly roundId: string | null,
    public readonly gameId: string | null,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | null,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    processedAt: Date | null,
    referenceTransactionId: string | null,
    failureCode: FailureCode | null,
  ) {
    this.currentStatus = status;
    this.currentProcessedAt = processedAt;
    this.currentReferenceTransactionId = referenceTransactionId;
    this.currentFailureCode = failureCode;
  }

  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  get processedAt(): Date | null {
    return this.currentProcessedAt === null
      ? null
      : new Date(this.currentProcessedAt);
  }

  /** Id interno da transação referenciada (FK `reference_transaction_id`). */
  get referenceTransactionId(): string | null {
    return this.currentReferenceTransactionId;
  }

  get failureCode(): FailureCode | null {
    return this.currentFailureCode;
  }

  /** Cria a transação interna de abertura da wallet. */
  static createOpening(
    props: CreateOpeningTransactionProps,
  ): WagerTransaction {
    if (!props.id.trim()) {
      throw new Error('Transaction ID is required');
    }

    if (!props.walletId.trim()) {
      throw new Error('Wallet ID is required');
    }

    if (!props.playerId.trim()) {
      throw new Error('Player ID is required');
    }

    // O OPENING só existe quando o saldo inicial é maior que zero
    // (README 9) e o ledger exige amount > 0 na migration inicial.
    if (!props.money.isPositive()) {
      throw new Error('OPENING amount must be positive');
    }

    const createdAt = props.createdAt ?? new Date();

    WagerTransaction.assertValidDate(createdAt);

    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      null,
      null,
      null,
      null,
      null,
      null,
      WagerTransactionKind.OPENING,
      props.money,
      null,
      createdAt,
      WagerTransactionStatus.PROCESSED,
      createdAt,
      null,
      null,
    );
  }

  /** Cria uma BET: débito, sem referência (README §7). */
  static createBet(props: CreateBetTransactionProps): WagerTransaction {
    return WagerTransaction.createExternal(WagerTransactionKind.BET, props);
  }

  /** Cria uma WIN: crédito, com referência opcional (README §7). */
  static createWin(props: CreateWinTransactionProps): WagerTransaction {
    return WagerTransaction.createExternal(WagerTransactionKind.WIN, props);
  }

  /** Cria uma LOSS: resultado informativo, sem efeito de saldo (README §7). */
  static createLoss(props: CreateLossTransactionProps): WagerTransaction {
    return WagerTransaction.createExternal(WagerTransactionKind.LOSS, props);
  }

  /** Cria um REFUND: crédito que reverte uma BET, com referência exigida. */
  static createRefund(props: CreateRefundTransactionProps): WagerTransaction {
    return WagerTransaction.createExternal(WagerTransactionKind.REFUND, props);
  }

  /** Cria um ROLLBACK: reversão de referência, com referência exigida. */
  static createRollback(
    props: CreateRollbackTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.createExternal(
      WagerTransactionKind.ROLLBACK,
      props,
    );
  }

  /**
   * Constrói qualquer operação de provedor em `PENDING` (README 6.3),
   * validando campos obrigatórios, limites das colunas, formato do hash,
   * valor monetário e a política de referência do kind.
   */
  private static createExternal(
    kind: WagerTransactionKind,
    props: ExternalTransactionProps,
  ): WagerTransaction {
    WagerTransaction.assertRequiredText('Transaction ID', props.id);
    WagerTransaction.assertRequiredText('Wallet ID', props.walletId);
    WagerTransaction.assertRequiredText('Player ID', props.playerId);
    WagerTransaction.assertRequiredText('Provider ID', props.providerId);
    WagerTransaction.assertRequiredText(
      'External transaction ID',
      props.externalTransactionId,
    );
    WagerTransaction.assertRequiredText('Idempotency key', props.idempotencyKey);
    WagerTransaction.assertRequiredText('Round ID', props.roundId);
    WagerTransaction.assertRequiredText('Game ID', props.gameId);

    // Limites das colunas correspondentes (migration inicial).
    WagerTransaction.assertMaxLength('Provider ID', props.providerId, 100);
    WagerTransaction.assertMaxLength(
      'External transaction ID',
      props.externalTransactionId,
      255,
    );
    WagerTransaction.assertMaxLength(
      'Idempotency key',
      props.idempotencyKey,
      255,
    );
    WagerTransaction.assertMaxLength('Round ID', props.roundId, 255);
    WagerTransaction.assertMaxLength('Game ID', props.gameId, 255);

    // Coluna payload_hash varchar(64); o algoritmo adotado é SHA-256 em
    // hexadecimal minúsculo (ver `application/wagering/payload-hash.ts`).
    if (!/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new Error(
        'Payload hash must be a 64-character lowercase hex digest',
      );
    }

    if (!props.money.isPositive()) {
      throw new Error(`${kind} amount must be positive`);
    }

    const referenceExternalTransactionId = WagerTransaction.resolveReference(
      kind,
      props.referenceExternalTransactionId,
    );

    const createdAt = props.createdAt ?? new Date();

    WagerTransaction.assertValidDate(createdAt);

    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      kind,
      props.money,
      referenceExternalTransactionId,
      createdAt,
      WagerTransactionStatus.PENDING,
      null,
      null,
      null,
    );
  }

  /**
   * Política de referência por kind (README §7, regra 1 e tabela):
   * REFUND/ROLLBACK exigem, WIN aceita, BET/LOSS não admitem.
   */
  private static resolveReference(
    kind: WagerTransactionKind,
    reference: string | null | undefined,
  ): string | null {
    if (reference === undefined || reference === null) {
      if (
        kind === WagerTransactionKind.REFUND ||
        kind === WagerTransactionKind.ROLLBACK
      ) {
        throw new Error('Reference external transaction ID is required');
      }

      return null;
    }

    if (!reference.trim()) {
      throw new Error('Reference external transaction ID must not be empty');
    }

    if (kind === WagerTransactionKind.BET) {
      throw new Error('BET does not support a reference');
    }

    if (kind === WagerTransactionKind.LOSS) {
      throw new Error('LOSS does not support a reference');
    }

    return reference;
  }

  /** Reconstrução a partir da persistência — não revalida (README 6.0). */
  static rehydrate(
    props: RehydrateWagerTransactionProps,
  ): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      props.status,
      props.processedAt,
      props.referenceTransactionId,
      props.failureCode,
    );
  }

  /**
   * `PENDING` ou `PENDING_REFERENCE` → `PROCESSED` (README 6.3).
   * Guarda o id interno da referência resolvida e o instante da aplicação.
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    WagerTransaction.assertValidDate(at);

    this.currentStatus = WagerTransactionStatus.PROCESSED;
    this.currentProcessedAt = new Date(at);
    this.currentReferenceTransactionId = referenceTransactionId ?? null;
  }

  /**
   * `PENDING` → `PENDING_REFERENCE` (README §7, regra 8). Repetir a
   * chamada já em `PENDING_REFERENCE` é no-op idempotente: o worker de
   * reprocessamento (§7.1) reavalia a cada ciclo.
   */
  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');

    if (this.currentStatus === WagerTransactionStatus.PENDING_REFERENCE) {
      return;
    }

    this.currentStatus = WagerTransactionStatus.PENDING_REFERENCE;
  }

  /** Qualquer estado não terminal → `REJECTED` (viola regra de negócio). */
  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    WagerTransaction.assertFailureCode(code);

    this.currentStatus = WagerTransactionStatus.REJECTED;
    this.currentFailureCode = code;
  }

  /** Qualquer estado não terminal → `FAILED` (falha permanente de infra). */
  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    WagerTransaction.assertFailureCode(code);

    this.currentStatus = WagerTransactionStatus.FAILED;
    this.currentFailureCode = code;
  }

  /** PROCESSED, REJECTED e FAILED são estados terminais (README 6.3). */
  isTerminal(): boolean {
    return (
      this.currentStatus === WagerTransactionStatus.PROCESSED ||
      this.currentStatus === WagerTransactionStatus.REJECTED ||
      this.currentStatus === WagerTransactionStatus.FAILED
    );
  }

  /** `false` apenas para LOSS: registra resultado sem mover saldo (§7). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.LOSS;
  }

  /** REFUND e ROLLBACK exigem referência externa (README §7, regra 1). */
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.REFUND ||
      this.kind === WagerTransactionKind.ROLLBACK
    );
  }

  /** Replay só quando o payload de negócio é idêntico (README §9). */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash !== null && this.payloadHash === payloadHash;
  }

  /**
   * Direção da entrada de ledger desta operação (README §7):
   * - `BET` → `DEBIT`;
   * - `WIN`, `REFUND` e `OPENING` → `CREDIT`;
   * - `LOSS` → lança erro: não gera lançamento (§6.4 e §7);
   * - `ROLLBACK` → inverso da referência, que precisa existir e ser
   *   `BET`, `WIN` ou `REFUND` (§7, regra 3 — ROLLBACK não reverte LOSS,
   *   OPENING nem outro ROLLBACK).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (
      this.kind === WagerTransactionKind.OPENING ||
      this.kind === WagerTransactionKind.WIN ||
      this.kind === WagerTransactionKind.REFUND
    ) {
      return LedgerDirection.CREDIT;
    }

    if (this.kind === WagerTransactionKind.BET) {
      return LedgerDirection.DEBIT;
    }

    if (this.kind === WagerTransactionKind.LOSS) {
      throw new Error('LOSS does not generate ledger entries');
    }

    // ROLLBACK
    if (!reference) {
      throw new Error('ROLLBACK requires its reference transaction');
    }

    const referenceIsReversible =
      reference.kind === WagerTransactionKind.BET ||
      reference.kind === WagerTransactionKind.WIN ||
      reference.kind === WagerTransactionKind.REFUND;

    if (!referenceIsReversible) {
      throw new Error(
        'ROLLBACK can only invert a BET, WIN or REFUND transaction',
      );
    }

    const referenceDirection = reference.ledgerDirectionFor();

    return referenceDirection === LedgerDirection.CREDIT
      ? LedgerDirection.DEBIT
      : LedgerDirection.CREDIT;
  }

  private static assertRequiredText(field: string, value: string): void {
    if (!value || !value.trim()) {
      throw new Error(`${field} is required`);
    }
  }

  private static assertMaxLength(
    field: string,
    value: string,
    max: number,
  ): void {
    if (value.length > max) {
      throw new Error(`${field} must be at most ${max} characters`);
    }
  }

  private static assertFailureCode(code: FailureCode): void {
    if (!code) {
      throw new Error('Failure code is required');
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${action} a transaction in terminal status ${this.currentStatus}`,
      );
    }
  }

  private static assertValidDate(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }
  }
}
