import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import {
  InboxMessage,
  InboxMessageStatus,
  type RehydrateInboxMessageProps,
} from '../../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';
import { InboxMessageRepository } from './inbox-message.repository.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAYLOAD_HASH = 'a'.repeat(64);
const RECEIVED_AT = new Date('2026-10-24T12:00:00.000Z');

function receivedMessage(id = ID) {
  return InboxMessage.receive({
    id,
    consumerName: 'wager-transactions',
    messageId: 'msg-123',
    eventType: 'WagerTransactionRequested',
    payloadHash: PAYLOAD_HASH,
    payload: { kind: 'BET', money: { amount: '25.00', currency: 'BRL' } },
    receivedAt: RECEIVED_AT,
  });
}

function rehydrated(
  overrides: Partial<RehydrateInboxMessageProps> = {},
): InboxMessage {
  return InboxMessage.rehydrate({
    id: ID,
    consumerName: 'wager-transactions',
    messageId: 'msg-123',
    eventType: 'WagerTransactionRequested',
    payloadHash: PAYLOAD_HASH,
    payload: { kind: 'BET' },
    status: InboxMessageStatus.RECEIVED,
    attempts: 0,
    nextAttemptAt: RECEIVED_AT,
    lastError: null,
    receivedAt: RECEIVED_AT,
    processedAt: null,
    createdAt: RECEIVED_AT,
    updatedAt: RECEIVED_AT,
    ...overrides,
  });
}

function repositoryWith(fake: FakeEntityManager): InboxMessageRepository {
  return new InboxMessageRepository(fake.asEntityManager());
}

describe('InboxMessageRepository — busca pela chave lógica (§10)', () => {
  it('acha a mensagem registrada por (consumerName, messageId)', async () => {
    const fake = new FakeEntityManager();
    fake.seed(InboxMessageEntity, {
      id: ID,
      consumerName: 'wager-transactions',
      messageId: 'msg-123',
      eventType: 'WagerTransactionRequested',
      payloadHash: PAYLOAD_HASH,
      payload: { kind: 'BET' },
      status: InboxMessageStatus.RECEIVED,
      attempts: 0,
      nextAttemptAt: RECEIVED_AT,
      lastError: null,
      receivedAt: RECEIVED_AT,
      processedAt: null,
      createdAt: RECEIVED_AT,
      updatedAt: RECEIVED_AT,
    });

    const found = await repositoryWith(fake).findByMessageKey(
      'wager-transactions',
      'msg-123',
    );

    expect(found).not.toBeNull();
    expect(found!.id).toBe(ID);
    expect(found!.isProcessed()).toBe(false);
  });

  it('não acha chave desconhecida nem mensagem de outro consumidor', async () => {
    const fake = new FakeEntityManager();
    fake.seed(InboxMessageEntity, {
      id: ID,
      consumerName: 'wager-transactions',
      messageId: 'msg-123',
      eventType: 'WagerTransactionRequested',
      payloadHash: PAYLOAD_HASH,
      payload: { kind: 'BET' },
      status: InboxMessageStatus.RECEIVED,
      attempts: 0,
      nextAttemptAt: RECEIVED_AT,
      lastError: null,
      receivedAt: RECEIVED_AT,
      processedAt: null,
      createdAt: RECEIVED_AT,
      updatedAt: RECEIVED_AT,
    });

    const repository = repositoryWith(fake);

    await expect(
      repository.findByMessageKey('wager-transactions', 'msg-999'),
    ).resolves.toBeNull();
    await expect(
      repository.findByMessageKey('outro-consumidor', 'msg-123'),
    ).resolves.toBeNull();
  });
});

describe('InboxMessageRepository — persistência', () => {
  it('persiste a mensagem recebida e a devolve como não processada', async () => {
    const fake = new FakeEntityManager();
    const repository = repositoryWith(fake);

    await repository.save(receivedMessage());

    const found = await repository.findByMessageKey(
      'wager-transactions',
      'msg-123',
    );

    expect(found).not.toBeNull();
    expect(found!.isProcessed()).toBe(false);
    expect(found!.processedAt).toBeNull();
    expect(found!.attempts).toBe(0);
    expect(found!.payload).toEqual({
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
  });

  it('persiste a conclusão do processamento', async () => {
    const fake = new FakeEntityManager();
    const repository = repositoryWith(fake);

    const message = receivedMessage();
    await repository.save(message);

    const processedAt = new Date('2026-10-24T12:00:30.000Z');
    message.markProcessed(processedAt);
    await repository.save(message);

    const found = await repository.findByMessageKey(
      'wager-transactions',
      'msg-123',
    );

    expect(found!.isProcessed()).toBe(true);
    expect(found!.status).toBe(InboxMessageStatus.PROCESSED);
    expect(found!.processedAt).toEqual(processedAt);
  });

  it('persiste o estado e os dados de erro já registrados', async () => {
    const fake = new FakeEntityManager();
    const repository = repositoryWith(fake);
    const nextAttemptAt = new Date('2026-10-24T12:05:00.000Z');

    await repository.save(
      rehydrated({
        status: InboxMessageStatus.FAILED,
        attempts: 3,
        nextAttemptAt,
        lastError: 'SIMULATED_SQS_OUTAGE',
      }),
    );

    const found = await repository.findByMessageKey(
      'wager-transactions',
      'msg-123',
    );

    expect(found!.status).toBe(InboxMessageStatus.FAILED);
    expect(found!.attempts).toBe(3);
    expect(found!.nextAttemptAt).toEqual(nextAttemptAt);
    expect(found!.lastError).toBe('SIMULATED_SQS_OUTAGE');
    expect(found!.isProcessed()).toBe(false);
  });
});

describe('InboxMessageRepository — restrição única (consumer, messageId)', () => {
  /**
   * A garantia é do banco (`inbox_consumer_message_unique`) — o que se
   * verifica aqui é o CONTRATO do repositório: ele não deduplica em memória
   * e deixa a violação subir para quem chama. A prova da constraint em si é
   * do schema e dos testes de integração (etapa seguinte).
   */
  it('não deduplica em memória: chave repetida vira violação da única', async () => {
    const fake = new FakeEntityManager();
    const repository = repositoryWith(fake);

    await repository.save(receivedMessage(ID));

    // Mesma chave lógica, outro id: só o banco pode recusar.
    await expect(
      repository.save(receivedMessage(OTHER_ID)),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);

    expect(fake.rows<InboxMessageEntity>(InboxMessageEntity)).toHaveLength(1);
  });
});
