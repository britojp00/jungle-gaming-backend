
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction.js';
import { WalletEntity } from './wallet.entity.js';

// Os enums de domínio são a fonte única; a entidade apenas os reexporta
// para manter os imports atuais desta camada.
export { WagerTransactionKind, WagerTransactionStatus };

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_transactions_provider_external_id_unique',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transactions_provider_idempotency_unique',
  properties: ['providerId', 'idempotencyKey'],
})
@Check({
  name: 'wager_transactions_amount_non_negative',
  expression: 'amount >= 0',
})
@Check({
  name: 'wager_transactions_kind_valid',
  expression:
    "kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
})
@Check({
  name: 'wager_transactions_status_valid',
  expression:
    "status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
})
@Check({
  name: 'wager_transactions_opening_internal',
  expression:
    "(kind <> 'OPENING') OR (provider_id IS NULL AND external_transaction_id IS NULL AND idempotency_key IS NULL AND payload_hash IS NULL)",
})
@Check({
  name: 'wager_transactions_reference_attempts_non_negative',
  expression: 'reference_attempts >= 0',
})
@Check({
  name: 'wager_transactions_external_fields_valid',
  expression: `
    (
      kind = 'OPENING'
      AND provider_id IS NULL
      AND external_transaction_id IS NULL
      AND idempotency_key IS NULL
      AND payload_hash IS NULL
    )
    OR
    (
      kind <> 'OPENING'
      AND provider_id IS NOT NULL
      AND external_transaction_id IS NOT NULL
      AND idempotency_key IS NOT NULL
      AND payload_hash IS NOT NULL
    )
  `,
})
@Index({
  name: 'wager_transactions_wallet_created_idx',
  properties: ['wallet', 'createdAt'],
})
/**
 * Segundo caminho da resolução da referência (README §7, regra 2): o
 * fallback que procura o mesmo `externalTransactionId` em OUTRO provider.
 * O unique `(provider_id, external_transaction_id)` não atende essa consulta
 * porque `provider_id` é a coluna líder. Medição em 200.000 linhas (20,03 ms
 * / 6.351 buffers sem índice contra 0,059 ms / 4 buffers com ele) — ver a
 * migration `PendingReferenceRetry`.
 */
@Index({
  name: 'wager_transactions_external_id_idx',
  properties: ['externalTransactionId'],
})
/**
 * Varredura do worker de §7.1: parcial porque só as linhas
 * `PENDING_REFERENCE` interessam, e com a janela de retry na liderança para
 * atender `WHERE status = ... AND reference_next_attempt_at <= $now ORDER BY
 * reference_next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED` sem varrer a
 * tabela. Idêntico ao índice criado pela migration
 * `Migration20261024150000_PendingReferenceRetry`.
 */
@Index({
  name: 'wager_transactions_pending_reference_idx',
  properties: ['referenceNextAttemptAt', 'id'],
  where: "status = 'PENDING_REFERENCE'",
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, {
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  wallet!: WalletEntity;

  @Property({ name: 'player_id', type: 'string', length: 255 })
  playerId!: string;

  @Property({
    name: 'provider_id',
    type: 'string',
    length: 100,
    nullable: true,
  })
  providerId: string | null = null;

  @Property({
    name: 'external_transaction_id',
    type: 'string',
    length: 255,
    nullable: true,
  })
  externalTransactionId: string | null = null;

  @Property({
    name: 'idempotency_key',
    type: 'string',
    length: 255,
    nullable: true,
  })
  idempotencyKey: string | null = null;

  @Property({
    name: 'payload_hash',
    type: 'string',
    length: 64,
    nullable: true,
  })
  payloadHash: string | null = null;

  @Property({ name: 'round_id', type: 'string', length: 255, nullable: true })
  roundId: string | null = null;

  @Property({ name: 'game_id', type: 'string', length: 255, nullable: true })
  gameId: string | null = null;

  @Property({ type: 'string', length: 20 })
  kind!: WagerTransactionKind;

  @Property({ type: 'string', length: 30 })
  status!: WagerTransactionStatus;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    name: 'reference_external_transaction_id',
    type: 'string',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId: string | null = null;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'reference_transaction_id',
    nullable: true,
    deleteRule: 'restrict',
  })
  referenceTransaction: WagerTransactionEntity | null = null;

  @Property({ name: 'rejection_reason', type: 'string', nullable: true })
  rejectionReason: string | null = null;

  /**
   * Estado do reprocessamento de uma linha `PENDING_REFERENCE` (README §7.1).
   * As duas colunas nascem com a migration `PendingReferenceRetry`: a
   * tentativa é contada no claim e a janela seguinte é gravada antes de
   * liberar a linha.
   */
  @Property({ name: 'reference_attempts', type: 'integer', default: 0 })
  referenceAttempts = 0;

  @Property({
    name: 'reference_next_attempt_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  referenceNextAttemptAt = new Date();

  @Property({
    name: 'result_balance_amount',
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
  })
  resultBalanceAmount: string | null = null;

  @Property({
    name: 'result_balance_currency',
    type: 'string',
    length: 3,
    nullable: true,
  })
  resultBalanceCurrency: string | null = null;

  @Property({
    name: 'result_wallet_version',
    type: 'integer',
    nullable: true,
  })
  resultWalletVersion: number | null = null;

  @Property({
    name: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt = new Date();

  @Property({
    name: 'updated_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
    onUpdate: () => new Date(),
  })
  updatedAt = new Date();

  @Property({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null = null;
}
