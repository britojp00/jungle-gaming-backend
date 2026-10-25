import { Logger } from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { FakeEntityManager } from '../../../test/support/fake-entity-manager.js';
import { InboxMessageStatus } from '../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../../infrastructure/persistence/entities/inbox-message.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionStatus,
} from '../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity.js';
import { SqsCommandQueue } from '../sqs/sqs-command-queue.js';
import type { SqsReceivedMessage } from '../sqs/sqs-client.js';
import {
  WagerCommandConsumerWorker,
  CONSUMER_ENABLED_ENV,
  CONSUMER_POLL_MS_ENV,
  DEFAULT_CONSUMER_POLL_MS,
  resolveConsumerPollMs,
} from './wager-command-consumer.worker.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-24T12:00:00.000Z');

const VALID_BODY = JSON.stringify({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-24T11:59:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

function message(overrides: Partial<SqsReceivedMessage> = {}) {
  return {
    messageId: 'sqm-1',
    receiptHandle: 'rh-1',
    body: VALID_BODY,
    ...overrides,
  };
}

function seededWalletRow(balance: string) {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
  };
}

/**
 * Fila de comandos de teste: registra as chamadas na ordem em que acontecem.
 * Não simula o broker — o que está em jogo é a ORQUESTRAÇÃO do worker
 * (quando confirma, quando usa a DLQ).
 */
class StubQueue {
  readonly calls: string[] = [];
  messages: SqsReceivedMessage[] = [];
  failForward = false;

  receive(): Promise<SqsReceivedMessage[]> {
    this.calls.push('receive');
    return Promise.resolve([...this.messages]);
  }

  acknowledge(receiptHandle: string): Promise<void> {
    this.calls.push(`ack:${receiptHandle}`);
    return Promise.resolve();
  }

  forwardToDeadLetter(messageId: string): Promise<void> {
    this.calls.push(`dlq:${messageId}`);

    return this.failForward
      ? Promise.reject(new Error('SIMULATED_DLQ_OUTAGE'))
      : Promise.resolve();
  }
}

function workerWith(fake: FakeEntityManager, queue: StubQueue) {
  return new WagerCommandConsumerWorker(
    fake.asEntityManager(),
    queue as unknown as SqsCommandQueue,
  );
}

function readyFake(): FakeEntityManager {
  const fake = new FakeEntityManager();
  fake.seed(WalletEntity, seededWalletRow('100.00'));

  return fake;
}

describe('resolveConsumerPollMs — configuração', () => {
  it('usa o padrão quando a variável não existe ou é inválida', () => {
    expect(resolveConsumerPollMs({})).toBe(DEFAULT_CONSUMER_POLL_MS);
    expect(resolveConsumerPollMs({ [CONSUMER_POLL_MS_ENV]: 'x' })).toBe(
      DEFAULT_CONSUMER_POLL_MS,
    );
    expect(resolveConsumerPollMs({ [CONSUMER_POLL_MS_ENV]: '10' })).toBe(
      DEFAULT_CONSUMER_POLL_MS,
    );
  });
});

describe('WagerCommandConsumerWorker — ciclo (§10)', () => {
  let errorSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processa e confirma somente depois do processamento persistido', async () => {
    const fake = readyFake();
    const queue = new StubQueue();
    queue.messages = [message()];

    const result = await workerWith(fake, queue).tick(NOW);

    expect(result).toMatchObject({
      received: 1,
      processed: 1,
      deadLettered: 0,
      retried: 0,
    });
    expect(queue.calls).toEqual(['receive', 'ack:rh-1']);
    expect(
      fake.rows<Record<string, unknown>>(InboxMessageEntity)[0]!['status'],
    ).toBe(InboxMessageStatus.PROCESSED);
  });

  it('envelope inválido vai para a DLQ e só é confirmado depois', async () => {
    const fake = readyFake();
    const queue = new StubQueue();
    queue.messages = [
      message({ body: JSON.stringify({ type: 'Desconhecido' }) }),
    ];

    const result = await workerWith(fake, queue).tick(NOW);

    expect(result).toMatchObject({ deadLettered: 1, processed: 0 });
    // A ordem importa: encaminhar antes de confirmar (§10).
    expect(queue.calls).toEqual(['receive', 'dlq:sqm-1', 'ack:rh-1']);
  });

  it('falha transitória não confirma — a reentrega do SQS assume', async () => {
    const fake = readyFake();
    fake.beforeFlush = () => {
      throw new Error('SIMULATED_DB_OUTAGE');
    };

    const queue = new StubQueue();
    queue.messages = [message()];

    const result = await workerWith(fake, queue).tick(NOW);

    expect(result).toMatchObject({ retried: 1, deadLettered: 0 });
    expect(queue.calls).toEqual(['receive']);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('conflito de idempotência é permanente: DLQ e confirmação', async () => {
    const fake = readyFake();

    // Mesma chave de idempotência com payload divergente (§9): conflito, não
    // replay — nunca vai funcionar em outra entrega.
    fake.seed(WagerTransactionEntity, {
      id: '33333333-3333-4333-8333-333333333333',
      wallet: { __reference: true, entityClass: WalletEntity, id: WALLET_ID },
      playerId: 'player-1',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      payloadHash: 'b'.repeat(64),
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      status: WagerTransactionStatus.PROCESSED,
      amount: '25.00',
      currency: 'BRL',
      referenceExternalTransactionId: null,
      referenceTransaction: null,
      rejectionReason: null,
      processedAt: NOW,
      resultBalanceAmount: '75.00',
      resultBalanceCurrency: 'BRL',
      resultWalletVersion: 2,
      referenceAttempts: 0,
      referenceNextAttemptAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const queue = new StubQueue();
    queue.messages = [message()];

    const result = await workerWith(fake, queue).tick(NOW);

    expect(result).toMatchObject({ deadLettered: 1 });
    expect(queue.calls).toEqual(['receive', 'dlq:sqm-1', 'ack:rh-1']);
  });

  it('violação da única da Inbox vira duplicata: confirma sem repetir', async () => {
    const fake = readyFake();

    // Outra entrega já registrou a mesma chave (ainda não confirmada): só o
    // banco recusa, e a recusa é interpretada como "já em andamento".
    fake.seed(InboxMessageEntity, {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      consumerName: 'wager-transactions',
      messageId: 'msg-123',
      eventType: 'WagerTransactionRequested',
      payloadHash: 'a'.repeat(64),
      payload: {},
      status: InboxMessageStatus.RECEIVED,
      attempts: 0,
      nextAttemptAt: NOW,
      lastError: null,
      receivedAt: NOW,
      processedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const queue = new StubQueue();
    queue.messages = [message()];

    const result = await workerWith(fake, queue).tick(NOW);

    expect(result).toMatchObject({ duplicate: 1, processed: 0 });
    expect(queue.calls).toEqual(['receive', 'ack:rh-1']);
  });

  it('DLQ indisponível impede a confirmação da mensagem original', async () => {
    const fake = readyFake();
    const queue = new StubQueue();
    queue.messages = [
      message({ body: JSON.stringify({ type: 'Desconhecido' }) }),
    ];
    queue.failForward = true;

    // §10: confirmar só depois que o encaminhamento funciona.
    await expect(workerWith(fake, queue).tick(NOW)).resolves.toBeNull();
    expect(queue.calls).toEqual(['receive', 'dlq:sqm-1']);
  });

  it('não sobrepõe ciclos e o desligamento aguarda o ciclo em andamento', async () => {
    const fake = readyFake();
    const queue = new StubQueue();
    queue.messages = [message()];

    const worker = workerWith(fake, queue);
    const cycle = worker.tick(NOW);

    // Enquanto o primeiro ciclo roda, o seguinte é pulado.
    expect(await worker.tick(NOW)).toBeNull();

    await expect(cycle).resolves.toMatchObject({ processed: 1 });

    await worker.onModuleDestroy();
    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('não agenda quando desabilitado por variável de ambiente', async () => {
    vi.useFakeTimers();

    try {
      process.env[CONSUMER_ENABLED_ENV] = 'false';

      const worker = workerWith(readyFake(), new StubQueue());
      const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

      worker.onModuleInit();
      vi.advanceTimersByTime(DEFAULT_CONSUMER_POLL_MS * 3);

      expect(tick).not.toHaveBeenCalled();
      await worker.onModuleDestroy();
    } finally {
      vi.useRealTimers();
      delete process.env[CONSUMER_ENABLED_ENV];
      delete process.env[CONSUMER_POLL_MS_ENV];
    }
  });
});
