import { Migration } from '@mikro-orm/migrations';

/**
 * D2 — regra 4 do README §7: "uma referência não pode ser revertida duas
 * vezes pelo mesmo tipo de operação". A regra fala em referência **revertida**,
 * e o índice anterior cobria todas as linhas `REFUND`/`ROLLBACK` com
 * referência — inclusive `REJECTED` e `PENDING_REFERENCE`.
 *
 * Consequência: uma reversão rejeitada por valor incorreto ocupava a chave e
 * impedia para sempre a tentativa corrigida. O índice passa a cobrir apenas
 * reversões **`PROCESSED`** (as que de fato reverteram); tentativas rejeitadas
 * ou pendentes continuam auditáveis como linhas próprias.
 */
export class Migration20261025120000_ReversalUniqueProcessed extends Migration {
  override name = 'Migration20261025120000_ReversalUniqueProcessed';

  override async up(): Promise<void> {
    this.addSql(`drop index "wager_transactions_reversal_unique";`);

    this.addSql(`
      create unique index "wager_transactions_reversal_unique"
        on "wager_transactions" (
          "provider_id",
          "reference_external_transaction_id",
          "kind"
        )
      where "kind" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index "wager_transactions_reversal_unique";`);

    this.addSql(`
      create unique index "wager_transactions_reversal_unique"
        on "wager_transactions" (
          "provider_id",
          "reference_external_transaction_id",
          "kind"
        )
      where "kind" in ('REFUND', 'ROLLBACK');
    `);
  }
}
