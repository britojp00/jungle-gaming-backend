import { createHash } from 'node:crypto';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';

/**
 * Subconjunto de campos de negócio que compõem o `payloadHash` (README 9).
 * O header `Idempotency-Key` e metadados de transporte não entram — eles
 * sequer são aceitos por este tipo.
 *
 * Todos os campos são obrigatórios: a ausência de um dado (sem rodada, sem
 * jogo, sem referência) deve ser representada explicitamente como `null`,
 * para que o JSON canônico tenha sempre o mesmo conjunto de chaves.
 */
export interface WagerPayload {
  kind: WagerTransactionKind;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  amount: string;
  currency: string;
  roundId: string | null;
  gameId: string | null;
  referenceExternalTransactionId: string | null;
}

/**
 * `payloadHash` (README 9): SHA-256, em hexadecimal minúsculo (64
 * caracteres), do JSON canônico do payload — **chaves ordenadas
 * alfabeticamente** e sem espaços.
 *
 * - `kind` participa do hash: a unique de idempotência é global por
 *   `(providerId, idempotencyKey)`, então a mesma chave usada para
 *   operações de tipos diferentes precisa resultar em conflito, nunca em
 *   replay (README §9: "mesma key com payload diferente → conflito").
 * - `referenceExternalTransactionId` participa: é campo de negócio de
 *   WIN/REFUND/ROLLBACK.
 * - Valores `undefined` são normalizados para `null` antes da
 *   serialização, então `roundId: undefined` e `roundId: null` produzem o
 *   mesmo digest.
 *
 * Os valores são escalares (`string` ou `null`); o payload é plano, como o
 * corpo documentado no README §9.
 */
export function hashWagerPayload(payload: WagerPayload): string {
  const entries = Object.entries(payload).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  const canonical: Record<string, string | null> = {};

  for (const [key, value] of entries) {
    canonical[key] = value ?? null;
  }

  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
