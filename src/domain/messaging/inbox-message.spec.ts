import { describe, expect, it } from 'vitest';

import {
  InboxMessage,
  InboxMessageStatus,
  type RehydrateInboxMessageProps,
  type ReceiveInboxProps,
} from './inbox-message.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYLOAD_HASH = 'a'.repeat(64);
const RECEIVED_AT = new Date('2026-10-24T12:00:00.000Z');

function receiveProps(
  overrides: Partial<ReceiveInboxProps> = {},
): ReceiveInboxProps {
  return {
    id: ID,
    consumerName: 'wager-transactions',
    messageId: 'msg-123',
    eventType: 'WagerTransactionRequested',
    payloadHash: PAYLOAD_HASH,
    payload: { kind: 'BET', money: { amount: '25.00', currency: 'BRL' } },
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function rehydrateProps(
  overrides: Partial<RehydrateInboxMessageProps> = {},
): RehydrateInboxMessageProps {
  return {
    ...receiveProps(),
    status: InboxMessageStatus.RECEIVED,
    attempts: 0,
    nextAttemptAt: RECEIVED_AT,
    lastError: null,
    receivedAt: RECEIVED_AT,
    processedAt: null,
    createdAt: RECEIVED_AT,
    updatedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe('InboxMessage.receive — mensagem recebida (§6.5)', () => {
  it('registra como RECEIVED, ainda não processada e sem erro', () => {
    const message = InboxMessage.receive(receiveProps());

    expect(message.status).toBe(InboxMessageStatus.RECEIVED);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeNull();
    expect(message.attempts).toBe(0);
    expect(message.lastError).toBeNull();
    expect(message.nextAttemptAt).toEqual(RECEIVED_AT);
  });

  it('carrega a identidade do consumidor e da mensagem e o payload', () => {
    const props = receiveProps();
    const message = InboxMessage.receive(props);

    expect(message.id).toBe(ID);
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.messageId).toBe('msg-123');
    expect(message.eventType).toBe('WagerTransactionRequested');
    expect(message.payloadHash).toBe(PAYLOAD_HASH);
    expect(message.payload).toEqual(props.payload);
    expect(message.receivedAt).toEqual(RECEIVED_AT);
    expect(message.createdAt).toEqual(RECEIVED_AT);
    expect(message.updatedAt).toEqual(RECEIVED_AT);
  });

  it('usa o instante atual quando a mensagem não traz o recebimento', () => {
    const before = Date.now();
    const message = InboxMessage.receive(receiveProps({ receivedAt: undefined }));

    expect(message.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('InboxMessage.rehydrate — reconstrução sem revalidar (§6.0)', () => {
  it('reconstrói o estado persistido, inclusive tentativas e erro', () => {
    const nextAttemptAt = new Date('2026-10-24T12:05:00.000Z');
    const message = InboxMessage.rehydrate(
      rehydrateProps({
        status: InboxMessageStatus.FAILED,
        attempts: 3,
        nextAttemptAt,
        lastError: 'SIMULATED_SQS_OUTAGE',
      }),
    );

    expect(message.status).toBe(InboxMessageStatus.FAILED);
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(nextAttemptAt);
    expect(message.lastError).toBe('SIMULATED_SQS_OUTAGE');
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeNull();
  });

  it('não revalida dados que o banco já aceitou', () => {
    // `rehydrate` só reconstrói: não reexecuta as regras de `receive`.
    const message = InboxMessage.rehydrate(rehydrateProps({ messageId: '' }));

    expect(message.messageId).toBe('');
    expect(message.isProcessed()).toBe(false);
  });
});

describe('InboxMessage.markProcessed — conclusão do processamento (§6.5)', () => {
  it('fica processada no instante informado', () => {
    const message = InboxMessage.receive(receiveProps());
    const processedAt = new Date('2026-10-24T12:00:30.000Z');

    message.markProcessed(processedAt);

    expect(message.status).toBe(InboxMessageStatus.PROCESSED);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
    expect(message.updatedAt).toEqual(processedAt);
  });

  it('é idempotente: repetir preserva o resultado original', () => {
    const message = InboxMessage.receive(receiveProps());
    const first = new Date('2026-10-24T12:00:30.000Z');
    const second = new Date('2026-10-24T12:00:45.000Z');

    message.markProcessed(first);
    message.markProcessed(second);

    // A Inbox torna o redelivery seguro (§10): marcar de novo não é erro e
    // não sobrescreve a conclusão (§7, regra 7).
    expect(message.status).toBe(InboxMessageStatus.PROCESSED);
    expect(message.processedAt).toEqual(first);
    expect(message.updatedAt).toEqual(first);
  });

  it('recusa data inválida', () => {
    const message = InboxMessage.receive(receiveProps());

    expect(() => message.markProcessed(new Date('inválido'))).toThrow(
      'Invalid date',
    );
  });
});

describe('InboxMessage.receive — dados inválidos', () => {
  it('exige identidade, consumidor, tipo e hash', () => {
    expect(() => InboxMessage.receive(receiveProps({ id: ' ' }))).toThrow(
      'Inbox ID is required',
    );
    expect(() =>
      InboxMessage.receive(receiveProps({ consumerName: '' })),
    ).toThrow('Consumer name is required');
    expect(() =>
      InboxMessage.receive(receiveProps({ messageId: '' })),
    ).toThrow('Message ID is required');
    expect(() =>
      InboxMessage.receive(receiveProps({ eventType: '  ' })),
    ).toThrow('Event type is required');
    expect(() =>
      InboxMessage.receive(receiveProps({ payloadHash: '' })),
    ).toThrow('Payload hash is required');
  });

  it('respeita os limites das colunas do schema', () => {
    expect(() =>
      InboxMessage.receive(receiveProps({ consumerName: 'c'.repeat(101) })),
    ).toThrow('Consumer name must be at most 100 characters');
    expect(() =>
      InboxMessage.receive(receiveProps({ messageId: 'm'.repeat(256) })),
    ).toThrow('Message ID must be at most 255 characters');
    expect(() =>
      InboxMessage.receive(receiveProps({ eventType: 'e'.repeat(101) })),
    ).toThrow('Event type must be at most 100 characters');
  });

  it('exige o hash canônico documentado (§9)', () => {
    expect(() =>
      InboxMessage.receive(receiveProps({ payloadHash: 'abc' })),
    ).toThrow('Payload hash must be a 64-character lowercase hex digest');
    expect(() =>
      InboxMessage.receive(receiveProps({ payloadHash: 'A'.repeat(64) })),
    ).toThrow('Payload hash must be a 64-character lowercase hex digest');
    expect(() =>
      InboxMessage.receive(receiveProps({ payloadHash: 'a'.repeat(63) })),
    ).toThrow('Payload hash must be a 64-character lowercase hex digest');
  });

  it('exige payload em objeto e data de recebimento válida', () => {
    expect(() =>
      InboxMessage.receive(
        receiveProps({ payload: null as unknown as Record<string, unknown> }),
      ),
    ).toThrow('Payload must be an object');
    expect(() =>
      InboxMessage.receive(
        receiveProps({ payload: [1, 2] as unknown as Record<string, unknown> }),
      ),
    ).toThrow('Payload must be an object');
    expect(() =>
      InboxMessage.receive(receiveProps({ receivedAt: new Date('inválido') })),
    ).toThrow('Invalid date');
  });
});
