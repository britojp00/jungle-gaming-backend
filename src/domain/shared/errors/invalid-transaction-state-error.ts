/**
 * Lançado quando uma transição de estado é tentada a partir de um estado
 * terminal (README 6.3: `PROCESSED`, `REJECTED` e `FAILED` são terminais e
 * "tentar transicioná-la é erro de programação, não caminho de negócio").
 *
 * Erro de programação, distinto das rejeições de negócio — estas carregam
 * um `FailureCode` e são estados do domínio, não exceções.
 */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}
