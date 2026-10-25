import { Money } from '../../domain/shared/value-objects/money.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';
import { validateRequiredStrings } from '../wagering/process-support.js';

/**
 * Mensagem de comando recebida pelo consumidor (README §10).
 *
 * Contrato oficial:
 *
 * ```json
 * {
 *   "messageId": "msg-123",
 *   "type": "WagerTransactionRequested",
 *   "occurredAt": "2026-07-29T15:00:00.000Z",
 *   "data": {
 *     "providerId": "provider-a", "externalTransactionId": "transaction-123",
 *     "idempotencyKey": "provider-a:transaction-123", "playerId": "…",
 *     "walletId": "…", "roundId": "round-987", "gameId": "fortune-chimp",
 *     "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
 *   }
 * }
 * ```
 *
 * `referenceExternalTransactionId` não aparece no exemplo, mas §7 (regras 1 e
 * 2) o exige quando o `kind` referencia outra transação; é aceito como
 * opcional e repassado ao caso de uso, que aplica a política por kind.
 */
export const WAGER_TRANSACTION_REQUESTED_TYPE = 'WagerTransactionRequested';

export interface WagerTransactionRequestedData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionRequested {
  messageId: string;
  type: string;
  occurredAt: Date;
  data: WagerTransactionRequestedData;
}

/**
 * Envelope inválido: erro **permanente** (§10) — repetir a entrega nunca
 * conserta o conteúdo da mensagem.
 */
export class InvalidEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvelopeError';
  }
}

function requiredText(field: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidEnvelopeError(`${field} is required`);
  }

  return value;
}

/**
 * Valida o envelope oficial `WagerTransactionRequested` (§10) sem tocar no
 * banco. Tudo que é rejeitado aqui é **permanente**: o mesmo conteúdo nunca
 * será aceito em outra entrega.
 */
export function parseWagerTransactionRequested(
  body: unknown,
): WagerTransactionRequested {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidEnvelopeError('Message body must be an object');
  }

  const envelope = body as Record<string, unknown>;

  if (envelope['type'] !== WAGER_TRANSACTION_REQUESTED_TYPE) {
    throw new InvalidEnvelopeError(
      `Unknown message type: ${String(envelope['type'])}`,
    );
  }

  const messageId = requiredText('messageId', envelope['messageId']);

  const occurredAtRaw = envelope['occurredAt'];
  const occurredAt =
    typeof occurredAtRaw === 'string' ? new Date(occurredAtRaw) : new Date(NaN);

  if (Number.isNaN(occurredAt.getTime())) {
    throw new InvalidEnvelopeError('occurredAt must be a valid ISO-8601 date');
  }

  const data = envelope['data'];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new InvalidEnvelopeError('data must be an object');
  }

  const fields = data as Record<string, unknown>;

  try {
    validateRequiredStrings({
      providerId: fields['providerId'],
      externalTransactionId: fields['externalTransactionId'],
      idempotencyKey: fields['idempotencyKey'],
      playerId: fields['playerId'],
      walletId: fields['walletId'],
      roundId: fields['roundId'],
      gameId: fields['gameId'],
    });
  } catch (error) {
    // Validação de payload é erro PERMANENTE do envelope (§10): o mesmo
    // conteúdo nunca será aceito — vira `InvalidEnvelopeError` para a
    // classificação não confundir com falha transitória.
    throw new InvalidEnvelopeError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const kind = fields['kind'];

  if (
    kind !== WagerTransactionKind.BET &&
    kind !== WagerTransactionKind.WIN &&
    kind !== WagerTransactionKind.LOSS &&
    kind !== WagerTransactionKind.REFUND &&
    kind !== WagerTransactionKind.ROLLBACK
  ) {
    throw new InvalidEnvelopeError(`Unsupported kind: ${String(kind)}`);
  }

  const money = fields['money'];

  if (!money || typeof money !== 'object' || Array.isArray(money)) {
    throw new InvalidEnvelopeError('money must be an object');
  }

  const moneyFields = money as Record<string, unknown>;

  if (
    typeof moneyFields['amount'] !== 'string' ||
    typeof moneyFields['currency'] !== 'string'
  ) {
    throw new InvalidEnvelopeError('money.amount and money.currency are required');
  }

  // Rejeita aqui o que os casos de uso rejeitariam depois — assim um valor
  // inválido é erro permanente do envelope, e não uma falha de processamento.
  try {
    Money.from({
      amount: moneyFields['amount'],
      currency: moneyFields['currency'],
    });
  } catch (error) {
    throw new InvalidEnvelopeError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const reference = fields['referenceExternalTransactionId'];

  if (
    reference !== undefined &&
    (typeof reference !== 'string' || !reference.trim())
  ) {
    throw new InvalidEnvelopeError(
      'referenceExternalTransactionId must be a non-empty string',
    );
  }

  // Política de referência por kind (§7, regras 1 e 2): BET/LOSS não
  // referenciam; REFUND/ROLLBACK exigem referência.
  if (
    (kind === WagerTransactionKind.BET || kind === WagerTransactionKind.LOSS) &&
    reference !== undefined
  ) {
    throw new InvalidEnvelopeError(`${kind} does not support a reference`);
  }

  if (
    (kind === WagerTransactionKind.REFUND ||
      kind === WagerTransactionKind.ROLLBACK) &&
    reference === undefined
  ) {
    throw new InvalidEnvelopeError(
      'Reference external transaction ID is required',
    );
  }

  return {
    messageId,
    type: WAGER_TRANSACTION_REQUESTED_TYPE,
    occurredAt,
    data: {
      providerId: fields['providerId'] as string,
      externalTransactionId: fields['externalTransactionId'] as string,
      idempotencyKey: fields['idempotencyKey'] as string,
      playerId: fields['playerId'] as string,
      walletId: fields['walletId'] as string,
      roundId: fields['roundId'] as string,
      gameId: fields['gameId'] as string,
      kind,
      money: {
        amount: moneyFields['amount'],
        currency: moneyFields['currency'],
      },
      ...(typeof reference === 'string'
        ? { referenceExternalTransactionId: reference }
        : {}),
    },
  };
}
