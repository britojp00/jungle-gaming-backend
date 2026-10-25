import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { integrationEnv } from './support/env.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';

/**
 * API HTTP (README §9) contra o **PostgreSQL real** de integração.
 *
 * Contratos conferidos no README: `POST /wallets` devolve
 * `{id, playerId, balance, version}`; `POST /wagering/transactions` devolve
 * `{transactionId, status, balance, idempotentReplay}` com o
 * `Idempotency-Key` no header; a reconciliação devolve
 * `{walletId, storedBalance, calculatedBalance, difference, consistent,
 * checkedEntries}`; e o status HTTP distingue payload inválido (400),
 * conflito de idempotência (409), rejeição por regra (422), aceite pendente
 * (202) e falha transitória (503).
 */

let app: INestApplication;
let harnessOrm: MikroORM;

beforeAll(async () => {
  harnessOrm = await bootstrapIntegrationOrm();

  // O AppModule conecta pelo `DATABASE_URL` e precisa das variáveis de SQS
  // para montar os workers — que ficam desligados aqui (o HTTP é o alvo).
  process.env['DATABASE_URL'] = integrationEnv.databaseUrl;
  process.env['SQS_ENDPOINT'] = integrationEnv.sqsEndpoint;
  process.env['SQS_WAGER_QUEUE_URL'] = 'http://127.0.0.1:4567/000000000000/queue.fifo';
  process.env['SQS_WAGER_DLQ_URL'] = 'http://127.0.0.1:4567/000000000000/dlq.fifo';
  process.env['SQS_EVENTS_QUEUE_URL'] = 'http://127.0.0.1:4567/000000000000/events.fifo';
  process.env['PENDING_REFERENCE_WORKER_ENABLED'] = 'false';
  process.env['OUTBOX_PUBLISHER_ENABLED'] = 'false';
  process.env['WAGER_CONSUMER_ENABLED'] = 'false';

  const { AppModule } = await import('../../src/app.module.js');
  const { Test } = await import('@nestjs/testing');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app.close();
  await disposeIntegrationOrm();
});

beforeEach(async () => {
  await truncateIntegrationTables();
});

function playerId(): string {
  return `it-http-${randomUUID()}`;
}

async function openWallet(player: string, amount = '1000.00') {
  const response = await request(app.getHttpServer())
    .post('/wallets')
    .send({ playerId: player, initialBalance: { amount, currency: 'BRL' } });

  expect(response.status).toBe(201);

  return response.body as {
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  };
}

function betBody(walletId: string, player: string, amount = '25.00') {
  const id = randomUUID();

  return {
    providerId: 'provider-a',
    externalTransactionId: `transaction-${id}`,
    playerId: player,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

describe('API HTTP (§9) — wallets', () => {
  it('POST /wallets cria com o contrato do README', async () => {
    const player = playerId();

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: player, initialBalance: { amount: '1000.00', currency: 'BRL' } });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId: player,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('wallet duplicada para o mesmo playerId + currency falha como conflito', async () => {
    const player = playerId();
    await openWallet(player);

    const again = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: player, initialBalance: { amount: '10.00', currency: 'BRL' } });

    expect(again.status).toBe(409);
  });

  it('payload inválido é 400', async () => {
    const missing = await request(app.getHttpServer())
      .post('/wallets')
      .send({ initialBalance: { amount: '10.00', currency: 'BRL' } });

    expect(missing.status).toBe(400);

    const badMoney = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: playerId(), initialBalance: { amount: 'dez', currency: 'BRL' } });

    expect(badMoney.status).toBe(400);
  });

  it('GET /wallets/:walletId devolve a carteira e 404 quando não existe', async () => {
    const wallet = await openWallet(playerId());

    const found = await request(app.getHttpServer()).get(`/wallets/${wallet.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      id: wallet.id,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const missing = await request(app.getHttpServer()).get(`/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it('GET /wallets/:walletId/ledger pagina com cursor opaco', async () => {
    const player = playerId();
    const wallet = await openWallet(player);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(betBody(wallet.id, player));

    const first = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=1`);

    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(1);
    expect(first.body.entries[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
    });
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app.getHttpServer()).get(
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${first.body.nextCursor}`,
    );

    expect(second.status).toBe(200);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.entries[0]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(second.body.nextCursor).toBeNull();
  });

  it('POST /wallets/:walletId/reconciliation confere saldo e ledger', async () => {
    const player = playerId();
    const wallet = await openWallet(player);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(betBody(wallet.id, player));

    const response = await request(app.getHttpServer())
      .post(`/wallets/${wallet.id}/reconciliation`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('divergência é sinalizada, nunca corrigida silenciosamente', async () => {
    const player = playerId();
    const wallet = await openWallet(player);

    // Corrompe o saldo materializado: a reconciliação tem de ACUSAR e não
    // pode corrigir nada (§9).
    await harnessOrm.em
      .getConnection()
      .execute(
        `update wallets set balance = '999.00' where id = '${wallet.id}'`,
      );

    const response = await request(app.getHttpServer())
      .post(`/wallets/${wallet.id}/reconciliation`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '999.00', currency: 'BRL' },
      calculatedBalance: { amount: '1000.00', currency: 'BRL' },
      difference: { amount: '-1.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });

    // Nada foi corrigido.
    const after = await request(app.getHttpServer()).get(`/wallets/${wallet.id}`);
    expect(after.body.balance).toEqual({ amount: '999.00', currency: 'BRL' });
  });
});

describe('API HTTP (§9) — transações', () => {
  it('POST /wagering/transactions aplica a BET com o contrato do README', async () => {
    const player = playerId();
    const wallet = await openWallet(player);

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(betBody(wallet.id, player));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('requisição idêntica devolve a mesma resposta com idempotentReplay: true', async () => {
    const player = playerId();
    const wallet = await openWallet(player);
    const body = betBody(wallet.id, player);
    const key = `key-${randomUUID()}`;

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body);
    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body);

    expect(replay.status).toBe(200);

    // §9: "requisição idêntica → mesma resposta, `idempotentReplay: true`":
    // o resultado é o mesmo, apenas marcado como replay.
    const { idempotentReplay: _first, ...firstRest } = first.body as Record<
      string,
      unknown
    >;
    const { idempotentReplay: _replay, ...replayRest } = replay.body as Record<
      string,
      unknown
    >;

    expect(replayRest).toEqual(firstRest);
    expect(first.body.idempotentReplay).toBe(false);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('mesma key com payload diferente é conflito, não replay', async () => {
    const player = playerId();
    const wallet = await openWallet(player);
    const key = `key-${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betBody(wallet.id, player, '25.00'));

    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(betBody(wallet.id, player, '30.00'));

    expect(conflict.status).toBe(409);
  });

  it('sem Idempotency-Key ou com payload inválido é 400', async () => {
    const player = playerId();
    const wallet = await openWallet(player);

    const noKey = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(betBody(wallet.id, player));

    expect(noKey.status).toBe(400);

    const badKind = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ ...betBody(wallet.id, player), kind: 'OPENING' });

    expect(badKind.status).toBe(400);

    const missingReference = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ ...betBody(wallet.id, player), kind: 'REFUND' });

    expect(missingReference.status).toBe(400);
  });

  it('rejeição por regra de negócio é 422 com o failureCode (§7.2)', async () => {
    const player = playerId();
    const wallet = await openWallet(player, '10.00');

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(betBody(wallet.id, player, '25.00'));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
    expect(response.body.balance).toEqual({
      amount: '10.00',
      currency: 'BRL',
    });
  });

  it('aceite com processamento pendente é 202 (referência ausente)', async () => {
    const player = playerId();
    const wallet = await openWallet(player);

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({
        ...betBody(wallet.id, player),
        kind: 'WIN',
        referenceExternalTransactionId: 'bet-ausente',
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
    });
  });

  it('consulta por id e por externalTransactionId do provedor', async () => {
    const player = playerId();
    const wallet = await openWallet(player);
    const body = betBody(wallet.id, player);

    const created = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(body);

    const byId = await request(app.getHttpServer()).get(
      `/wagering/transactions/${created.body.transactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      status: 'PROCESSED',
      kind: 'BET',
    });

    const byExternal = await request(app.getHttpServer()).get(
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.transactionId).toBe(created.body.transactionId);

    expect(
      (await request(app.getHttpServer()).get(`/wagering/transactions/${randomUUID()}`))
        .status,
    ).toBe(404);
  });
});

describe('API HTTP (§9) — health', () => {
  it('GET /health/live responde sem autenticação', async () => {
    const response = await request(app.getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready confere PostgreSQL e SQS', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      postgres: 'ok',
    });
  });
});
