import { describe, expect, it } from 'vitest';

import {
  SqsOutboxPublisher,
  sqsOutboxPublisherOptionsFromEnv,
} from './sqs-outbox-publisher.js';

const ENV = {
  SQS_ENDPOINT: 'http://localstack:4566',
  SQS_WAGER_QUEUE_URL:
    'http://localstack:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL:
    'http://localstack:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL:
    'http://localstack:4566/000000000000/wager-events.fifo',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

describe('sqsOutboxPublisherOptionsFromEnv — fila de eventos da outbox', () => {
  it('usa SQS_EVENTS_QUEUE_URL e não a fila de comandos', () => {
    const options = sqsOutboxPublisherOptionsFromEnv(ENV);

    // A outbox publica eventos de integração (§11); a fila de
    // `wager-transactions.fifo` é a entrada de comandos dos provedores (§10).
    expect(options.queueUrl).toContain('wager-events.fifo');
    expect(options.queueUrl).not.toContain('wager-transactions.fifo');
    expect(options.queueUrl).not.toContain('wager-transactions-dlq.fifo');
  });

  it('lê endpoint, região e credenciais do ambiente', () => {
    expect(sqsOutboxPublisherOptionsFromEnv(ENV)).toEqual({
      endpoint: 'http://localstack:4566',
      queueUrl: 'http://localstack:4566/000000000000/wager-events.fifo',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
  });

  it('fica sem destino quando SQS_EVENTS_QUEUE_URL não existe', () => {
    expect(sqsOutboxPublisherOptionsFromEnv({}).queueUrl).toBe('');
  });
});

describe('SqsOutboxPublisher — configuração obrigatória', () => {
  it('recusa sem fila de eventos configurada', () => {
    expect(
      () =>
        new SqsOutboxPublisher({
          ...sqsOutboxPublisherOptionsFromEnv(ENV),
          queueUrl: '',
        }),
    ).toThrow(/SQS_EVENTS_QUEUE_URL/);
  });

  it('recusa sem endpoint configurado', () => {
    expect(
      () =>
        new SqsOutboxPublisher({
          ...sqsOutboxPublisherOptionsFromEnv(ENV),
          endpoint: '',
        }),
    ).toThrow(/SQS_ENDPOINT/);
  });

  it('monta com as opções vindas do ambiente', () => {
    const publisher = new SqsOutboxPublisher(
      sqsOutboxPublisherOptionsFromEnv(ENV),
    );

    expect(publisher).toBeInstanceOf(SqsOutboxPublisher);
  });
});
