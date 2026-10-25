import { describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from '../../../infrastructure/persistence/entities/outbox-message.entity.js';
import {
  REFERENCE_RETRY_MAX_ATTEMPTS,
} from '../../wagering/reference-retry-policy.js';
import {
  OutboxPublisher,
  OutboxPublishing,
} from '../outbox-publisher.js';
import { PublishOutboxMessagesUseCase } from './publish-outbox-messages.use-case.js';

const MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const SECOND_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';
const AGGREGATE_ID = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-24T11:55:00.000Z');

function envelope(eventId: string) {
  return {
    eventId,
    eventType: 'WagerTransactionProcessed',
    aggregateId: AGGREGATE_ID,
    correlationId: eventId,
    occurredAt: CREATED_AT.toISOString(),
    version: 1,
    data: {
      transactionId: eventId,
      amount: { amount: '25.00', currency: 'BRL' },
    },
  };
}

/** Linha `PENDING` gravada pelo caso de uso no mesmo commit dos efeitos. */
function seededMessage(id = MESSAGE_ID, overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventType: 'WagerTransactionProcessed',
    aggregateId: AGGREGATE_ID,
    payload: envelope(id),
    status: OutboxMessageStatus.PENDING,
    attempts: 0,
    nextAttemptAt: CREATED_AT,
    lockedAt: null,
    lockOwner: null,
    lastError: null,
    occurredAt: CREATED_AT,
    publishedAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Linha do claim, com os MESMOS nomes de coluna do banco. */
function claimRowFor(
  id = MESSAGE_ID,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    event_type: 'WagerTransactionProcessed',
    aggregate_id: AGGREGATE_ID,
    payload: envelope(id),
    attempts: 0,
    ...overrides,
  };
}

class StubPublisher implements OutboxPublisher {
  readonly sent: OutboxPublishing[] = [];
  readonly failures = new Map<string, string>();

  async publish(message: OutboxPublishing): Promise<void> {
    const failure = this.failures.get(message.messageId);

    if (failure) {
      throw new Error(failure);
    }

    this.sent.push(message);
  }
}

function messageRow(fake: FakeEntityManager, id = MESSAGE_ID) {
  const row = fake
    .rows<Record<string, unknown>>(OutboxMessageEntity)
    .find((candidate) => candidate['id'] === id);

  expect(row).toBeDefined();

  return row!;
}

describe('PublishOutboxMessagesUseCase — claim e publicação', () => {
  it('reivindica com FOR UPDATE SKIP LOCKED, publica o payload inalterado e marca PUBLISHED', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor()];

    const publisher = new StubPublisher();
    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
      problems: [],
    });

    // A consulta é a da §11: só `PENDING`, dentro da janela e com tentativas
    // sobrando — o limite de retentativas vale já na seleção.
    expect(fake.executed).toHaveLength(1);
    expect(fake.executed[0]!.sql).toMatch(/for update skip locked/i);
    expect(fake.executed[0]!.sql).toMatch(
      /status = 'PENDING'[\s\S]*next_attempt_at <= \?[\s\S]*attempts < \?/i,
    );
    expect(fake.executed[0]!.params).toEqual([
      NOW,
      REFERENCE_RETRY_MAX_ATTEMPTS,
      20,
    ]);

    // O payload sai do jeito que entrou: o worker não reescreve o contrato.
    expect(publisher.sent).toEqual([
      {
        messageId: MESSAGE_ID,
        aggregateId: AGGREGATE_ID,
        payload: envelope(MESSAGE_ID),
      },
    ]);

    const row = messageRow(fake);
    expect(row['status']).toBe(OutboxMessageStatus.PUBLISHED);
    expect(row['publishedAt']).toEqual(NOW);
    expect(row['lastError']).toBeNull();
  });

  it('grava a próxima janela no claim, com o backoff já adotado', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor(MESSAGE_ID, { attempts: 3 })];

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      new StubPublisher(),
    );

    await useCase.execute({ now: NOW });

    // 4ª tentativa → 5 s × 2^3 = 40 s. A janela é gravada ANTES de publicar:
    // é o que impede outro publisher de levar a mesma mensagem.
    expect(messageRow(fake)['nextAttemptAt']).toEqual(
      new Date(NOW.getTime() + 40_000),
    );
  });

  it('não faz nada quando não há mensagem elegível', async () => {
    const fake = new FakeEntityManager();
    const publisher = new StubPublisher();

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ claimed: 0, published: 0, failed: 0 });
    expect(publisher.sent).toEqual([]);
  });
});

describe('PublishOutboxMessagesUseCase — falha de publicação', () => {
  it('registra o motivo e mantém a mensagem elegível para retentar', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor()];

    const publisher = new StubPublisher();
    publisher.failures.set(MESSAGE_ID, 'SQS indisponível');

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(result.problems).toEqual([
      {
        reason: 'PUBLISH_FAILED',
        messageId: MESSAGE_ID,
        eventType: 'WagerTransactionProcessed',
        detail: 'SQS indisponível',
      },
    ]);

    // A tentativa foi contada e a janela gravada no claim: a mensagem não se
    // perde e volta a ser elegível sozinha. Sem estado novo, sem fila morta.
    const row = messageRow(fake);
    expect(row['status']).toBe(OutboxMessageStatus.PENDING);
    expect(row['attempts']).toBe(1);
    expect(row['lastError']).toBe('SQS indisponível');
    expect(row['nextAttemptAt']).toEqual(new Date(NOW.getTime() + 5_000));
  });

  it('uma falha não impede as demais do lote', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.seed(OutboxMessageEntity, seededMessage(SECOND_MESSAGE_ID));
    fake.claimRows = [claimRowFor(), claimRowFor(SECOND_MESSAGE_ID)];

    const publisher = new StubPublisher();
    publisher.failures.set(MESSAGE_ID, 'rede fora');

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    const result = await useCase.execute({ now: NOW });

    expect(result).toMatchObject({
      claimed: 2,
      published: 1,
      failed: 1,
    });
    expect(publisher.sent.map((message) => message.messageId)).toEqual([
      SECOND_MESSAGE_ID,
    ]);
    expect(messageRow(fake, SECOND_MESSAGE_ID)['status']).toBe(
      OutboxMessageStatus.PUBLISHED,
    );
  });

  it('publica de novo na retentativa seguinte', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());

    const publisher = new StubPublisher();
    publisher.failures.set(MESSAGE_ID, 'falha transitória');

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    await useCase.execute({ now: NOW });

    publisher.failures.delete(MESSAGE_ID);
    fake.claimRows = [claimRowFor(MESSAGE_ID, { attempts: 1 })];

    const retry = await useCase.execute({
      now: new Date(NOW.getTime() + 5_000),
    });

    expect(retry).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(messageRow(fake)['status']).toBe(OutboxMessageStatus.PUBLISHED);
  });
});

describe('PublishOutboxMessagesUseCase — retentativas limitadas', () => {
  it('só reivindica mensagens com tentativas sobrando', async () => {
    const fake = new FakeEntityManager();
    fake.claimRows = [];

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      new StubPublisher(),
    );

    await useCase.execute({ now: NOW });

    // O filtro `attempts < limite` está na própria seleção: esgotadas as
    // tentativas, a mensagem continua na outbox (auditável) e não volta a
    // ser reivindicada — sem inventar estado de "mensagem morta".
    expect(fake.executed[0]!.sql).toMatch(/attempts < \?/i);
    expect(fake.executed[0]!.params).toContain(REFERENCE_RETRY_MAX_ATTEMPTS);
  });
});

describe('PublishOutboxMessagesUseCase — claim atômico', () => {
  it('não publica nada quando o claim falha', async () => {
    const fake = new FakeEntityManager();
    fake.failOnExecute = true;

    const publisher = new StubPublisher();

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    await expect(useCase.execute({ now: NOW })).rejects.toThrow(
      'SIMULATED_CLAIM_FAILURE',
    );

    expect(publisher.sent).toEqual([]);
  });

  it('a janela do claim já está gravada quando a publicação acontece', async () => {
    const fake = new FakeEntityManager();
    fake.seed(OutboxMessageEntity, seededMessage());
    fake.claimRows = [claimRowFor()];

    let windowAtPublish: unknown;
    const publisher: OutboxPublisher = {
      publish: async () => {
        windowAtPublish = messageRow(fake)['nextAttemptAt'];
      },
    };

    const useCase = new PublishOutboxMessagesUseCase(
      fake.asEntityManager(),
      publisher,
    );

    await useCase.execute({ now: NOW });

    // Tentativa e janela confirmam ANTES de publicar — é isso que torna a
    // queda entre as duas etapas auto-recuperável (§11: nada se perde).
    expect(windowAtPublish).toEqual(new Date(NOW.getTime() + 5_000));
  });
});
