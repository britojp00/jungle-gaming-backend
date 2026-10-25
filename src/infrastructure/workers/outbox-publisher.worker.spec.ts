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
import {
  OutboxPublisher,
  OutboxPublishing,
} from '../../application/messaging/outbox-publisher.js';
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from '../persistence/entities/outbox-message.entity.js';
import { SqsOutboxPublisher } from '../sqs/sqs-outbox-publisher.js';
import {
  DEFAULT_OUTBOX_POLL_MS,
  MIN_OUTBOX_POLL_MS,
  OUTBOX_PUBLISHER_ENABLED_ENV,
  OUTBOX_POLL_MS_ENV,
  OutboxPublisherWorker,
  resolveOutboxPollMs,
} from './outbox-publisher.worker.js';

const MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const AGGREGATE_ID = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-24T11:55:00.000Z');

function seededMessage() {
  return {
    id: MESSAGE_ID,
    eventType: 'WalletBalanceChanged',
    aggregateId: AGGREGATE_ID,
    payload: { eventId: MESSAGE_ID, data: { amount: { amount: '25.00' } } },
    status: OutboxMessageStatus.PENDING,
    attempts: 0,
    nextAttemptAt: CREATED_AT,
    lockedAt: null,
    lockOwner: null,
    lastError: null,
    occurredAt: CREATED_AT,
    publishedAt: null,
    createdAt: CREATED_AT,
  };
}

function claimRowFor(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    event_type: 'WalletBalanceChanged',
    aggregate_id: AGGREGATE_ID,
    payload: { eventId: MESSAGE_ID },
    attempts: 0,
    ...overrides,
  };
}

class StubPublisher implements OutboxPublisher {
  readonly sent: OutboxPublishing[] = [];
  failure: string | null = null;

  async publish(message: OutboxPublishing): Promise<void> {
    if (this.failure) {
      throw new Error(this.failure);
    }

    this.sent.push(message);
  }
}

function workerWith(
  fake: FakeEntityManager,
  publisher: OutboxPublisher = new StubPublisher(),
): OutboxPublisherWorker {
  return new OutboxPublisherWorker(
    fake.asEntityManager(),
    publisher as SqsOutboxPublisher,
  );
}

describe('resolveOutboxPollMs — configuração', () => {
  it('usa o padrão quando a variável não existe ou é inválida', () => {
    expect(resolveOutboxPollMs({})).toBe(DEFAULT_OUTBOX_POLL_MS);
    expect(resolveOutboxPollMs({ [OUTBOX_POLL_MS_ENV]: 'abc' })).toBe(
      DEFAULT_OUTBOX_POLL_MS,
    );
    expect(resolveOutboxPollMs({ [OUTBOX_POLL_MS_ENV]: '0' })).toBe(
      DEFAULT_OUTBOX_POLL_MS,
    );
    expect(resolveOutboxPollMs({ [OUTBOX_POLL_MS_ENV]: '-1000' })).toBe(
      DEFAULT_OUTBOX_POLL_MS,
    );
    expect(
      resolveOutboxPollMs({
        [OUTBOX_POLL_MS_ENV]: String(MIN_OUTBOX_POLL_MS - 1),
      }),
    ).toBe(DEFAULT_OUTBOX_POLL_MS);
  });

  it('aceita um intervalo válido', () => {
    expect(resolveOutboxPollMs({ [OUTBOX_POLL_MS_ENV]: '250' })).toBe(250);
    expect(
      resolveOutboxPollMs({ [OUTBOX_POLL_MS_ENV]: String(MIN_OUTBOX_POLL_MS) }),
    ).toBe(MIN_OUTBOX_POLL_MS);
  });
});

describe('OutboxPublisherWorker — ciclo', () => {
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

  it('delega ao caso de uso e registra o resumo do ciclo', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor()];

    const publisher = new StubPublisher();
    const worker = workerWith(fake, publisher);

    const result = await worker.tick(NOW);

    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(publisher.sent).toHaveLength(1);
    expect(String(logSpy.mock.calls.at(-1)![0])).toContain('"published":1');
  });

  it('não registra nada quando o claim volta vazio', async () => {
    const worker = workerWith(new FakeEntityManager());

    const result = await worker.tick(NOW);

    expect(result).toMatchObject({ claimed: 0, published: 0 });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('registra a falha de publicação como log estruturado, sem payload', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor()];

    const publisher = new StubPublisher();
    publisher.failure = 'SQS SendMessage falhou (HTTP 500)';

    const worker = workerWith(fake, publisher);
    const result = await worker.tick(NOW);

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 });

    const line = String(errorSpy.mock.calls[0]![0]);
    expect(line).toContain('"reason":"PUBLISH_FAILED"');
    expect(line).toContain(MESSAGE_ID);
    // Só identificadores e motivo: nunca o payload financeiro do evento.
    expect(line).not.toContain('25.00');
    expect(line).not.toContain('"data"');
  });

  it('falha do claim vira null, sem derrubar o agendador', async () => {
    const fake = new FakeEntityManager();
    fake.failOnExecute = true;

    const worker = workerWith(fake);

    await expect(worker.tick(NOW)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('não sobrepõe ciclos: enquanto um roda, o seguinte é pulado', async () => {
    const fake = new FakeEntityManager();
    fake.failOnExecute = true;

    const worker = workerWith(fake);

    const first = worker.tick(NOW);
    const second = await worker.tick(NOW);

    expect(second).toBeNull();
    await expect(first).resolves.toBeNull();
  });

  it('o desligamento gracioso aguarda o ciclo em andamento (§10/§14)', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor()];

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const publisher: OutboxPublisher = {
      publish: async () => {
        await gate;
      },
    };

    const worker = workerWith(fake, publisher);
    const cycle = worker.tick(NOW);

    let stopped = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    // O ciclo ainda não terminou: o SIGTERM espera, em vez de matar no meio.
    expect(stopped).toBe(false);

    release();
    await shutdown;

    expect(stopped).toBe(true);
    await expect(cycle).resolves.toMatchObject({
      claimed: 1,
      published: 1,
    });
  });
});

describe('OutboxPublisherWorker — agendamento', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env[OUTBOX_POLL_MS_ENV];
    delete process.env[OUTBOX_PUBLISHER_ENABLED_ENV];
  });

  it('agenda no intervalo configurado e para no desligamento', async () => {
    process.env[OUTBOX_POLL_MS_ENV] = '250';
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.onModuleInit();
    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(750);
    expect(tick).toHaveBeenCalledTimes(4);

    await worker.onModuleDestroy();
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('usa o padrão quando a configuração é inválida', async () => {
    process.env[OUTBOX_POLL_MS_ENV] = 'nope';
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.onModuleInit();
    vi.advanceTimersByTime(DEFAULT_OUTBOX_POLL_MS);

    expect(tick).toHaveBeenCalledTimes(1);
    await worker.onModuleDestroy();
  });

  it('não agenda quando desabilitado por variável de ambiente', async () => {
    process.env[OUTBOX_PUBLISHER_ENABLED_ENV] = 'false';
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.onModuleInit();
    vi.advanceTimersByTime(DEFAULT_OUTBOX_POLL_MS * 5);

    expect(tick).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('desabilitado');
    await worker.onModuleDestroy();
  });

  it('start é idempotente e stop sem efeito quando nada agenda', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const worker = workerWith(new FakeEntityManager());
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(null);

    worker.stop();
    worker.start();
    worker.start();

    vi.advanceTimersByTime(DEFAULT_OUTBOX_POLL_MS);
    expect(tick).toHaveBeenCalledTimes(1);

    await worker.onModuleDestroy();
  });
});
