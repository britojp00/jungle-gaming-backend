import { Migration } from '@mikro-orm/migrations';

/**
 * Fase 13 — worker de recuperação de referências pendentes (README §7.1).
 *
 * `wager_transactions` ganha o estado de reprocessamento de uma linha
 * `PENDING_REFERENCE`:
 *
 * - `reference_attempts` — tentativas já consumidas; incrementada DURANTE o
 *   claim, antes de liberar a linha, para que um crash depois do claim não
 *   reinicie um ciclo imediato (o custo é contar uma tentativa que não
 *   chegou a executar, comportamento documentado em `ARCHITECTURE.md`);
 * - `reference_next_attempt_at` — próxima janela elegível, o que torna o
 *   backoff exponencial agendável e consultável por SQL;
 * - índice parcial `(... ) WHERE status = 'PENDING_REFERENCE'` — a varredura
 *   do worker é sempre por status, e ~100% das linhas da tabela não estão
 *   nesse estado: um índice cheio seria pago a cada INSERT para nada. Com a
 *   janela na liderança, o `WHERE + ORDER BY + LIMIT + FOR UPDATE SKIP LOCKED`
 *   do claim não varre a tabela.
 *
 * Sem coluna de TTL: o prazo absoluto de 6 h é derivado de `created_at`, que
 * já existe — uma coluna só duplicaria estado que o banco já possui.
 *
 * O índice em `external_transaction_id` é o segundo caminho da resolução da
 * regra 2: quando `(provider_id, external_transaction_id)` não bate, o worker
 * pergunta se o mesmo identificador existe em OUTRO provider — consulta que,
 * sem índice próprio, não aproveita o unique (cuja coluna líder é
 * `provider_id`) e vira seq scan. Medido no banco de integração com 200.000
 * linhas: 20,03 ms / 6.351 buffers sem índice contra 0,059 ms / 4 buffers com
 * ele, e essa consulta roda em TODA tentativa que não resolve.
 */
export class Migration20261024150000_PendingReferenceRetry extends Migration {

  override name = 'Migration20261024150000_PendingReferenceRetry';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" add column "reference_attempts" int not null default 0;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_attempts_non_negative" check ("reference_attempts" >= 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add column "reference_next_attempt_at" timestamptz not null default now();`,
    );
    this.addSql(
      `create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("reference_next_attempt_at", "id") where "status" = 'PENDING_REFERENCE';`,
    );
    this.addSql(
      `create index "wager_transactions_external_id_idx" on "wager_transactions" ("external_transaction_id");`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `drop index if exists "wager_transactions_external_id_idx";`,
    );
    this.addSql(
      `drop index if exists "wager_transactions_pending_reference_idx";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint if exists "wager_transactions_reference_attempts_non_negative";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop column if exists "reference_next_attempt_at";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop column if exists "reference_attempts";`,
    );
  }
}
