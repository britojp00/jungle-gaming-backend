import { Migration } from '@mikro-orm/migrations';

/**
 * Regra 4 do README §7 reforçada: "uma transação não pode receber mais de uma
 * reversão **processada**", independentemente do tipo. O índice anterior era
 * por `(provider_id, reference_external_transaction_id, kind)`, então um
 * `REFUND` e um `ROLLBACK` da mesma referência podiam os dois ser aplicados —
 * dois créditos para a mesma `BET`, contra a invariante de §3 ("o sistema não
 * pode duplicar créditos").
 *
 * A chave perde o `kind`: cada referência admite **uma** reversão `PROCESSED`.
 * Continua permitido reverter um `REFUND` com `ROLLBACK`, porque aí a
 * referência é o próprio `REFUND` (outra chave).
 */
export class Migration20261025160000_ReversalUniquePerReference extends Migration {
  override name = 'Migration20261025160000_ReversalUniquePerReference';

  override async up(): Promise<void> {
    this.addSql(`drop index "wager_transactions_reversal_unique";`);

    this.addSql(`
      create unique index "wager_transactions_reversal_unique"
        on "wager_transactions" (
          "provider_id",
          "reference_external_transaction_id"
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
      where "kind" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED';
    `);
  }
}
