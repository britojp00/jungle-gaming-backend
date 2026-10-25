import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { Money } from '../../src/domain/shared/value-objects/money.js';
import { InboxMessageStatus } from '../../src/domain/messaging/inbox-message.js';
import { SqsCommandQueue } from '../../src/infrastructure/sqs/sqs-command-queue.js';
import { SqsClient } from '../../src/infrastructure/sqs/sqs-client.js';
import { WagerCommandConsumerWorker } from '../../src/infrastructure/workers/wager-command-consumer.worker.js';
import { OpenWalletUseCase } from '../../src/application/wallets/use-cases/open-wallet.use-case.js';
import { integrationEnv } from './support/env.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';
import { createSqsHttp, type SqsHttp } from './support/sqs.js';

/**
 * Consumidor da fila de comandos (README §10) contra **PostgreSQL e
 * LocalStack reais** — Inbox, efeitos financeiros, ledger e outbox na mesma
 * transação (§11), confirmação só depois do commit.
 *
 * Cenários: reentrega sem duplicar efeitos; atomicidade; falha entre commit
 * e confirmação (com recuperação por outra instância); erro transitório com
 * limite de tentativas até a DLQ; erro permanente direto à DLQ; concorrência
 * entre instâncias consumidoras.
 */

/** Limite baixo de recebimentos para o teste de DLQ ser rápido. */
const MAX_RECEIVE_COUNT = 2;
const VISIBILITY_TIMEOUT_SECONDS = 1;

let orm: MikroORM;
let sqs: SqsHttp;
let client: SqsClient;
let queue: SqsCommandQueue;
let queueUrl: string;
let deadLetterQueueUrl: string;

beforeAll(async () => {
  orm = await bootstrapIntegrationOrm();
  sqs = createSqsHttp();
  client = new SqsClient({
    endpoint: integrationEnv.sqsEndpoint,
    region: integrationEnv.region,
    accessKeyId: integrationEnv.accessKeyId,
    secretAccessKey: integrationEnv.secretAccessKey,
  });

  const created = await sqs.createQueueWithDeadLetter(
    `jungle-integration-consumer-${randomUUID().slice(0, 8)}.fifo`,
    `jungle-integration-consumer-dlq-${randomUUID().slice(0, 8)}.fifo`,
    MAX_RECEIVE_COUNT,
  );

  queueUrl = created.queueUrl;
  deadLetterQueueUrl = created.deadLetterQueueUrl;
  queue = new SqsCommandQueue({
    endpoint: integrationEnv.sqsEndpoint,
    queueUrl,
    deadLetterQueueUrl,
    region: integrationEnv.region,
    accessKeyId: integrationEnv.accessKeyId,
    secretAccessKey: integrationEnv.secretAccessKey,
  });
}, 60_000);

afterAll(async () => {
  await disposeIntegrationOrm();
});

beforeEach(async () => {
  await truncateIntegrationTables();
  await sqs.call('PurgeQueue', { QueueUrl: queueUrl });
  await sqs.call('PurgeQueue', { QueueUrl: deadLetterQueueUrl });
});

function instanceEm(): EntityManager {
  return orm.em.fork();
}

function consumer(
  queueOverride: SqsCommandQueue = queue,
  em: EntityManager = instanceEm(),
): WagerCommandConsumerWorker {
  return new WagerCommandConsumerWorker(
    em,
    queueOverride,
    VISIBILITY_TIMEOUT_SECONDS,
  );
}

function commandBody(
  overrides: {
    messageId?: string;
    walletId?: string;
    kind?: 'BET' | 'WIN';
    amount?: string;
  } = {},
): string {
  return JSON.stringify({
    messageId: overrides.messageId ?? `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: `transaction-${randomUUID()}`,
      idempotencyKey: `key-${randomUUID()}`,
      playerId: PLAYER_ID,
      walletId: overrides.walletId ?? walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: overrides.kind ?? 'BET',
      money: { amount: overrides.amount ?? '25.00', currency: 'BRL' },
    },
  });
}

const PLAYER_ID = 'player-1';
let walletId = '';

async function sendCommand(body: string, groupId = randomUUID()): Promise<void> {
  await client.sendMessage({
    queueUrl,
    messageBody: body,
    messageGroupId: groupId,
    messageDeduplicationId: randomUUID(),
  });
}

interface Row {
  [key: string]: unknown;
}

async function readRows(table: string): Promise<Row[]> {
  return (await orm.em.getConnection().execute(`select * from ${table}`)) as Row[];
}

async function readWallet(): Promise<{ balance: string; version: number }> {
  const rows = (await orm.em.getConnection().execute(
    `select balance, version from wallets where id = '${walletId}'`,
  )) as Array<{ balance: string; version: number }>;

  return rows[0]!;
}

async function openWallet(initial: string): Promise<void> {
  const opened = await new OpenWalletUseCase(instanceEm()).execute({
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: initial, currency: 'BRL' }),
  });

  walletId = opened.id;
}

/** Consome o que existe na fila informada (para conferir DLQ). */
async function receiveRaw(targetQueue: string): Promise<string[]> {
  const messages = await client.receiveMessages({
    queueUrl: targetQueue,
    maxMessages: 10,
    waitTimeSeconds: 1,
    // Visibilidade zero: a conferência não pode esconder as mensagens que
    // ainda estão na janela de reentrega.
    visibilityTimeout: 0,
  });

  return messages.map((message) => message.body);
}

/** Espera a janela de visibilidade vencer para ver a reentrega. */
async function waitForRedelivery(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, (VISIBILITY_TIMEOUT_SECONDS + 0.2) * 1_000),
  );
}

describe('Consumidor de comandos (§10) — Inbox transacional (§11)', () => {
  it('reentrega da mesma mensagem não duplica efeitos financeiros', async () => {
    await openWallet('100.00');

    const body = commandBody({ messageId: 'msg-repeated' });
    await sendCommand(body);
    await sendCommand(body);

    // As duas cópias chegam no MESMO ciclo: uma processa, a outra é
    // reconhecida pela Inbox e não produz efeito novo.
    const first = await consumer().tick();
    expect(first).toMatchObject({ received: 2, processed: 1, duplicate: 1 });

    const second = await consumer().tick();
    expect(second).toMatchObject({ received: 0 });

    // Um débito, uma transação, um lançamento e UM registro de Inbox.
    expect((await readWallet()).balance).toBe('75.00');
    expect((await readWallet()).version).toBe(2);
    expect(await readRows('wallet_ledger_entries')).toHaveLength(2); // abertura + BET
    expect(
      (await readRows('wager_transactions')).filter(
        (row) => row['kind'] === 'BET',
      ),
    ).toHaveLength(1);

    const inbox = await readRows('inbox_messages');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!['status']).toBe(InboxMessageStatus.PROCESSED);
    expect(inbox[0]!['processed_at']).not.toBeNull();
    expect(await receiveRaw(queueUrl)).toEqual([]);
  }, 30_000);

  it('atomicidade: falha no processamento não deixa Inbox nem efeitos', async () => {
    await openWallet('100.00');
    const before = await readWallet();

    // A Inbox é gravada ANTES dos efeitos; se o caso de uso falhar, nada
    // pode sobrar — nem a própria Inbox (§11: ou tudo, ou nada).
    await sendCommand(commandBody({ walletId: randomUUID() }));

    const result = await consumer().tick();

    expect(result).toMatchObject({ received: 1, retried: 1, processed: 0 });
    expect(await readRows('inbox_messages')).toEqual([]);
    expect(
      (await readRows('wager_transactions')).filter(
        (row) => row['kind'] === 'BET',
      ),
    ).toEqual([]);
    expect(await readWallet()).toEqual(before);

    // Nada foi confirmado: a mensagem volta pela visibilidade.
    await waitForRedelivery();
    expect((await receiveRaw(queueUrl)).length).toBe(1);
  }, 30_000);

  it('falha entre o commit e o ACK não duplica efeitos e outra instância assume', async () => {
    await openWallet('100.00');

    const body = commandBody({ messageId: 'msg-crash-ack' });
    await sendCommand(body);

    // A confirmação falha DEPOIS de o commit ter acontecido: é o "worker
    // morto depois do commit e antes do ack" (§13).
    let brokenAck = true;
    const failingQueue = new Proxy(queue, {
      get(target, property) {
        if (property === 'acknowledge') {
          return async (receiptHandle: string) => {
            if (brokenAck) {
              brokenAck = false;
              throw new Error('SIMULATED_ACK_FAILURE');
            }

            return target.acknowledge(receiptHandle);
          };
        }

        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const crashed = await consumer(failingQueue).tick();
    expect(crashed).toMatchObject({ processed: 1, retried: 1 });
    expect((await readWallet()).balance).toBe('75.00');

    // Outra instância (reinício) recebe a mesma mensagem de novo: a Inbox
    // impede o segundo efeito e a confirmação sai agora.
    await waitForRedelivery();
    const recovered = await consumer().tick();
    expect(recovered).toMatchObject({ duplicate: 1, processed: 0 });

    expect((await readWallet()).balance).toBe('75.00');
    expect((await readWallet()).version).toBe(2);
    expect(
      (await readRows('wager_transactions')).filter(
        (row) => row['kind'] === 'BET',
      ),
    ).toHaveLength(1);
    expect(await readRows('inbox_messages')).toHaveLength(1);
    expect(await receiveRaw(queueUrl)).toEqual([]);
  }, 30_000);

  it('erro transitório reentrega e, esgotado o limite, vai para a DLQ', async () => {
    await openWallet('100.00');

    // Carteira inexistente: falha transitória (nenhum efeito, nada é
    // confirmado) até o `maxReceiveCount` da fila levar à DLQ.
    await sendCommand(commandBody({ walletId: randomUUID() }));

    for (let attempt = 0; attempt < MAX_RECEIVE_COUNT + 2; attempt++) {
      await consumer().tick();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }

    expect(await readRows('inbox_messages')).toEqual([]);
    expect(
      (await readRows('wager_transactions')).filter(
        (row) => row['kind'] === 'BET',
      ),
    ).toEqual([]);
    expect(await receiveRaw(deadLetterQueueUrl)).toHaveLength(1);
    expect(await receiveRaw(queueUrl)).toEqual([]);
  }, 60_000);

  it('erro permanente vai para a DLQ e a mensagem original é confirmada', async () => {
    await openWallet('100.00');

    await sendCommand(JSON.stringify({ type: 'TipoDesconhecido' }));

    const result = await consumer().tick();

    expect(result).toMatchObject({ deadLettered: 1, processed: 0 });
    expect(await receiveRaw(deadLetterQueueUrl)).toHaveLength(1);
    expect(await receiveRaw(queueUrl)).toEqual([]);
    expect(await readRows('inbox_messages')).toEqual([]);
  }, 30_000);

  it('três consumidores concorrentes processam sem duplicar nem perder', async () => {
    await openWallet('1000.00');

    for (let index = 0; index < 6; index++) {
      await sendCommand(commandBody({ messageId: `msg-${index}` }));
    }

    const results = await Promise.all([
      consumer().tick(),
      consumer().tick(),
      consumer().tick(),
    ]);

    const processed = results.reduce(
      (sum, result) => sum + (result?.processed ?? 0),
      0,
    );
    const duplicates = results.reduce(
      (sum, result) => sum + (result?.duplicate ?? 0),
      0,
    );

    expect(processed).toBe(6);
    expect(duplicates).toBe(0);

    // Cada comando debitou uma vez: 1000.00 - 6 × 25.00.
    expect((await readWallet()).balance).toBe('850.00');
    expect(await readRows('inbox_messages')).toHaveLength(6);
    expect(
      (await readRows('wager_transactions')).filter(
        (row) => row['kind'] === 'BET',
      ),
    ).toHaveLength(6);
  }, 30_000);
});
