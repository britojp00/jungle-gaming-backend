import { Migration } from '@mikro-orm/migrations';

export class Migration20261024021931_InitialSchema extends Migration {

  override name = 'Migration20261024021931_InitialSchema';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "consumer_name" varchar(100) not null, "message_id" varchar(255) not null, "event_type" varchar(100) not null, "payload_hash" varchar(64) not null, "payload" jsonb not null, "status" varchar(20) not null default 'RECEIVED', "attempts" int not null default 0, "next_attempt_at" timestamptz not null default now(), "last_error" text null, "received_at" timestamptz not null default now(), "processed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "inbox_status_created_idx" on "inbox_messages" ("status", "created_at");`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_consumer_message_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "event_type" varchar(100) not null, "aggregate_id" uuid not null, "payload" jsonb not null, "status" varchar(20) not null default 'PENDING', "attempts" int not null default 0, "next_attempt_at" timestamptz not null default now(), "locked_at" timestamptz null, "lock_owner" varchar(255) null, "last_error" text null, "occurred_at" timestamptz not null default now(), "published_at" timestamptz null, "created_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "outbox_status_next_attempt_idx" on "outbox_messages" ("status", "next_attempt_at", "created_at");`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(255) not null, "currency" varchar(3) not null, "balance" numeric(20,2) not null, "version" int not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "wallet_id" uuid not null, "player_id" varchar(255) not null, "provider_id" varchar(100) null, "external_transaction_id" varchar(255) null, "idempotency_key" varchar(255) null, "payload_hash" varchar(64) null, "round_id" varchar(255) null, "game_id" varchar(255) null, "kind" varchar(20) not null, "status" varchar(30) not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "rejection_reason" varchar(255) null, "result_balance_amount" numeric(20,2) null, "result_balance_currency" varchar(3) null, "result_wallet_version" int null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_idempotency_unique" unique ("provider_id", "idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_id_unique" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(10) not null, "amount" numeric(20,2) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "currency" varchar(3) not null, "created_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);

    this.addSql(`alter table "inbox_messages" add constraint "inbox_status_valid" check (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED'));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_attempts_non_negative" check (attempts >= 0);`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_status_valid" check (status IN ('PENDING', 'PROCESSING', 'PUBLISHED'));`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_attempts_non_negative" check (attempts >= 0);`);

    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_opening_internal" check ((kind <> 'OPENING') OR (provider_id IS NULL AND external_transaction_id IS NULL AND idempotency_key IS NULL AND payload_hash IS NULL));`);
    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_external_fields_valid"
      check (
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
      );
    `);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_valid" check (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_valid" check (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_non_negative" check (amount >= 0);`);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_reversal_reference_required"
      check (
        kind NOT IN ('REFUND', 'ROLLBACK')
        OR reference_external_transaction_id IS NOT NULL
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX "wager_transactions_reversal_unique"
      ON "wager_transactions" (
        "provider_id",
        "reference_external_transaction_id",
        "kind"
      )
      WHERE "kind" IN ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_balance_consistent" check ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_direction_valid" check (direction IN ('CREDIT', 'DEBIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_balance_after_non_negative" check (balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_balance_before_non_negative" check (balance_before >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_amount_positive" check (amount > 0);`);
  }


  override down(): void | Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS wallet_ledger_immutable
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();
    `);

    this.addSql(`drop table if exists "wallet_ledger_entries";`);
    this.addSql(`drop table if exists "wager_transactions";`);
    this.addSql(`drop table if exists "wallets";`);
    this.addSql(`drop table if exists "outbox_messages";`);
    this.addSql(`drop table if exists "inbox_messages";`);
  }

}
