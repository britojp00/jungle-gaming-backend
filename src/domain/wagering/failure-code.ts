/**
 * Códigos de falha estáveis e legíveis por máquina (README 7.2: "a
 * taxonomia é sua — defina-a e documente-a").
 *
 * Cada código mapeia uma regra explícita do README oficial:
 *
 * - `INSUFFICIENT_FUNDS` — `BET` rejeitada por saldo insuficiente (§7,
 *   tabela de operações).
 * - `INSUFFICIENT_BALANCE_FOR_REVERSAL` — reversão que deixaria o saldo
 *   negativo (§7, regra 9). Deve ser **distinto** de `INSUFFICIENT_FUNDS`
 *   porque são situações operacionalmente diferentes.
 * - `REFERENCE_NOT_FOUND` — esgotado o limite de reprocessamento de uma
 *   transação `PENDING_REFERENCE` cuja referência nunca existiu (§7.1).
 * - `REFERENCE_MISMATCH` — a referência existe, mas pertence a outro
 *   provider, player, wallet, moeda ou rodada (§7, regra 2).
 * - `INTERNAL_ERROR` — falha permanente de infraestrutura, usada pelo
 *   status `FAILED` (§6.3: "erro permanente de infraestrutura").
 *
 * Persistência: gravado na coluna existente
 * `wager_transactions.rejection_reason` — sem migration nova, a coluna é o
 * lugar físico do código e o nome de domínio é `failureCode`. A troca de
 * nome de coluna foi descartada por não alterar semântica nenhuma.
 */
export enum FailureCode {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  INSUFFICIENT_BALANCE_FOR_REVERSAL = 'INSUFFICIENT_BALANCE_FOR_REVERSAL',
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  /** Regra 5: o valor da reversão difere do valor da referência. */
  REFERENCE_AMOUNT_MISMATCH = 'REFERENCE_AMOUNT_MISMATCH',
  /** Regra 4: a referência já foi revertida por este tipo de operação. */
  REFERENCE_ALREADY_REVERSED = 'REFERENCE_ALREADY_REVERSED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
