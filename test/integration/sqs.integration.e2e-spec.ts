import { beforeAll, describe, expect, it } from 'vitest';

import { integrationEnv } from './support/env.js';
import { createSqsHttp, type SqsHttp } from './support/sqs.js';

/**
 * Verificação REAL contra o LocalStack de integração (porta 4567).
 *
 * O projeto não tem o AWS SDK nem um publisher de produção, e esta etapa não
 * instala dependências nem inventa um publisher. Por isso aqui apenas se
 * prova que a fila de teste existe/é criável — o suficiente para destravar o
 * teste de publicação end-to-end depois.
 *
 * Ainda FALTA para validar publicação de eventos:
 * - um publisher SQS de produção (assinatura SigV4 + retry + DLQ);
 * - um worker/outbox relay que leia `outbox_messages` e publique após o
 *   commit, marcando a mensagem como PUBLISHED;
 * - testes de at-least-once, reprocessamento e dead-lettering.
 *
 * Nada disso é simulado aqui: sem publisher, não há o que publicar.
 */

let sqs: SqsHttp;

beforeAll(() => {
  sqs = createSqsHttp();
});

describe('LocalStack SQS de integração', () => {
  it('responde ao health check do endpoint de integração', async () => {
    const response = await fetch(
      `${integrationEnv.sqsEndpoint}/_localstack/health`,
    );

    expect(response.ok).toBe(true);

    const health = (await response.json()) as {
      services?: Record<string, string>;
    };

    expect(health.services?.sqs).toBeDefined();
  });

  it('cria a fila de teste e confirma que ela existe', async () => {
    const queueName = integrationEnv.sqsQueueName;

    // `CreateQueue` é idempotente: repetir a suíte não falha nem duplica.
    const createdUrl = await sqs.createQueue(queueName, true);

    expect(createdUrl).toContain(queueName);

    // Segunda chamada resolve a URL da fila já existente.
    const resolvedUrl = await sqs.getQueueUrl(queueName);

    expect(resolvedUrl).toBe(createdUrl);

    const urls = await sqs.listQueues();

    expect(urls).toContain(createdUrl);
  });

  it('usa um LocalStack separado do de desenvolvimento', async () => {
    const urls = await sqs.listQueues();

    // As filas de dev só existem na instância de dev (porta 4566) e são
    // criadas pelo init-queues.sh. Aqui elas NÃO podem aparecer: é a prova
    // de que a suíte de integração não lê nem apaga mensagens de dev.
    const devQueues = urls.filter((url) =>
      url.endsWith('/wager-transactions.fifo'),
    );

    expect(devQueues).toEqual([]);
  });

  it('falha com erro claro quando a fila não existe', async () => {
    await expect(
      sqs.getQueueUrl('jungle-integration-queue-that-does-not-exist.fifo'),
    ).rejects.toThrow(/GetQueueUrl falhou/);
  });
});
