import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { MikroORM } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/application/wallets/use-cases/open-wallet.use-case.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { LedgerDirection } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';
import { integrationEnv } from './support/env.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';

let orm: MikroORM;

beforeAll(async () => {
  orm = await bootstrapIntegrationOrm();
}, 60_000);

afterAll(async () => {
  await disposeIntegrationOrm();
});

beforeEach(async () => {
  await truncateIntegrationTables();
});

function connection() {
  return orm.em.getConnection();
}

function walletRow(playerId: string, balance = '10.00'): string {
  const id = randomUUID();

  return `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values ('${id}', '${playerId}', 'BRL', '${balance}', 1, now(), now())`;
}

describe('PostgreSQL de integração', () => {
  it('conecta ao banco exclusivo de integração', async () => {
    const rows = await connection().execute(
      'select current_database() as database',
    );

    // A trava em env.ts já bloqueia qualquer banco não-integração; aqui
    // confirmamos que a conexão ativa é de fato a esperada.
    expect(rows[0]!.database).toBe(
      new URL(integrationEnv.databaseUrl).pathname.slice(1),
    );
  });

  it('persiste uma transação bem-sucedida (controle positivo)', async () => {
    const wallet = new WalletEntity();
    wallet.id = randomUUID();
    wallet.playerId = 'it-committed';
    wallet.currency = 'BRL';
    wallet.balance = '10.00';

    await orm.em.transactional(async (tx) => {
      tx.persist(wallet);
      await tx.flush();
    });

    const rows = await connection().execute('select id from wallets');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(wallet.id);
  });

  it('faz rollback real desfazendo inserts já confirmados na transação', async () => {
    const survivor = new WalletEntity();
    survivor.id = randomUUID();
    survivor.playerId = 'it-survivor';
    survivor.currency = 'BRL';
    survivor.balance = '10.00';

    // Dado pré-existente, confirmado em transação própria.
    await orm.em.transactional(async (tx) => {
      tx.persist(survivor);
      await tx.flush();
    });

    const doomed = new WalletEntity();
    doomed.id = randomUUID();
    doomed.playerId = 'it-doomed';
    doomed.currency = 'BRL';
    doomed.balance = '10.00';

    // Usa o mesmo caminho do produção (persist + flush dentro de
    // `transactional`), não SQL cru: `getConnection().execute()` roda em
    // autocommit FORA da transação e não exercitaria o rollback.
    await expect(
      orm.em.transactional(async (tx) => {
        tx.persist(doomed);
        await tx.flush();

        throw new Error('falha proposital');
      }),
    ).rejects.toThrow('falha proposital');

    // Leitura por SQL cru, ignorando o identity map, para ver o estado real.
    const rows = await connection().execute(
      'select id from wallets order by created_at',
    );

    // O rollback é real E limitado à transação: o dado pré-existente
    // sobrevive, o confirmado na transação que falhou não existe.
    expect(rows.map((row) => row.id)).toEqual([survivor.id]);
    expect(rows.map((row) => row.id)).not.toContain(doomed.id);
  });

  it('o PostgreSQL impede carteira duplicada pela unique (player_id, currency)', async () => {
    const useCase = new OpenWalletUseCase(orm.em);

    await useCase.execute({
      playerId: 'it-duplicate',
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });

    await expect(
      useCase.execute({
        playerId: 'it-duplicate',
        initialBalance: Money.from({ amount: '2.00', currency: 'BRL' }),
      }),
    ).rejects.toThrow('WALLET_ALREADY_EXISTS');
  });

  it('o PostgreSQL aplica a constraint de saldo não negativo', async () => {
    await expect(
      connection().execute(walletRow('it-negative', '-1.00')),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  it('OpenWalletUseCase grava wallet, OPENING, ledger e outbox atomicamente', async () => {
    const useCase = new OpenWalletUseCase(orm.em);

    const result = await useCase.execute({
      playerId: 'it-player-atomic',
      initialBalance: Money.from({
        amount: '250.00',
        currency: 'BRL',
      }),
    });

    // Os quatro registros existem juntos: uma única transação SQL.
    const wallets = await connection().execute(
      `select id, player_id, currency, balance, version from wallets where id = '${result.id}'`,
    );

    expect(wallets).toEqual([
      {
        id: result.id,
        player_id: 'it-player-atomic',
        currency: 'BRL',
        balance: '250.00',
        version: 1,
      },
    ]);

    const openings = await connection().execute(
      `select kind, status, amount, currency from wager_transactions where wallet_id = '${result.id}'`,
    );

    expect(openings).toEqual([
      {
        kind: 'OPENING',
        status: 'PROCESSED',
        amount: '250.00',
        currency: 'BRL',
      },
    ]);

    // Inseriu com sucesso: o CHECK wallet_ledger_balance_consistent
    // (balance_after = balance_before + amount) foi validado pelo banco.
    const entries = await connection().execute(
      `select direction, amount, balance_before, balance_after, currency
       from wallet_ledger_entries where wallet_id = '${result.id}'`,
    );

    expect(entries).toEqual([
      {
        direction: LedgerDirection.CREDIT,
        amount: '250.00',
        balance_before: '0.00',
        balance_after: '250.00',
        currency: 'BRL',
      },
    ]);

    // Reconciliação materializado x ledger, contra os valores reais gravados.
    expect(wallets[0]!.balance).toBe(entries[0]!.balance_after);

    const outbox = await connection().execute(
      `select event_type, aggregate_id, status, payload
       from outbox_messages where aggregate_id = '${result.id}'`,
    );

    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.event_type).toBe('WalletBalanceChanged');
    expect(outbox[0]!.status).toBe('PENDING');

    const openingId = await connection().execute(
      `select id from wager_transactions where wallet_id = '${result.id}'`,
    );

    // Contrato README §11, agora serializado pelo PostgreSQL real.
    expect(outbox[0]!.payload.data).toEqual({
      walletId: result.id,
      transactionId: openingId[0]!.id,
      direction: LedgerDirection.CREDIT,
      money: { amount: '250.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '250.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('abertura com saldo zero grava apenas a carteira', async () => {
    const useCase = new OpenWalletUseCase(orm.em);

    const result = await useCase.execute({
      playerId: 'it-player-zero',
      initialBalance: Money.zero('BRL'),
    });

    expect(
      await connection().execute(
        `select id from wager_transactions where wallet_id = '${result.id}'`,
      ),
    ).toHaveLength(0);

    expect(
      await connection().execute(
        `select id from wallet_ledger_entries where wallet_id = '${result.id}'`,
      ),
    ).toHaveLength(0);

    expect(
      await connection().execute(
        `select id from outbox_messages where aggregate_id = '${result.id}'`,
      ),
    ).toHaveLength(0);
  });

  it('o trigger wallet_ledger_immutable impede UPDATE e DELETE (ledger append-only)', async () => {
    const useCase = new OpenWalletUseCase(orm.em);

    const result = await useCase.execute({
      playerId: 'it-ledger-immutable',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    // Invariante financeira aplicada NO BANCO, não apenas no domínio:
    // o trigger rejeita qualquer mutação de lançamento existente.
    await expect(
      connection().execute(
        `update wallet_ledger_entries set amount = '99.99' where wallet_id = '${result.id}'`,
      ),
    ).rejects.toThrow(/Wallet ledger entries are immutable/);

    await expect(
      connection().execute(
        `delete from wallet_ledger_entries where wallet_id = '${result.id}'`,
      ),
    ).rejects.toThrow(/Wallet ledger entries are immutable/);

    // Nada mudou: o lançamento original permanece íntegro.
    const entries = await connection().execute(
      `select direction, amount, balance_before, balance_after
       from wallet_ledger_entries where wallet_id = '${result.id}'`,
    );

    expect(entries).toEqual([
      {
        direction: LedgerDirection.CREDIT,
        amount: '10.00',
        balance_before: '0.00',
        balance_after: '10.00',
      },
    ]);
  });
});
