import {
  readTag,
  SqsClient,
  SqsClientOptions,
} from '../../../src/infrastructure/sqs/sqs-client.js';
import { integrationEnv } from './env.js';

/**
 * Harness de SQS para TESTE.
 *
 * O transporte (SigV4 sobre `fetch`, `call` e `SendMessage`) é o de
 * PRODUÇÃO — `src/infrastructure/sqs/sqs-client.ts`, o mesmo usado pelo
 * publisher da outbox — então a suíte de integração exercita o código real em
 * vez de um paralelo (README §13: nada de mock de SQS). Aqui ficam apenas as
 * operações de **administração de fila**, que são exclusivas do harness.
 */
export type SqsHttpOptions = SqsClientOptions;

export class SqsHttp {
  private readonly client: SqsClient;

  constructor(options: SqsHttpOptions) {
    this.client = new SqsClient(options);
  }

  /** Executa uma ação SQS (API Query) e devolve a resposta bruta em XML. */
  call(
    action: string,
    params: Record<string, string> = {},
  ): Promise<string> {
    return this.client.call(action, params);
  }

  /** Cria a fila se ainda não existir. `CreateQueue` é idempotente. */
  async createQueue(queueName: string, fifo = true): Promise<string> {
    const params: Record<string, string> = { QueueName: queueName };

    if (fifo) {
      params['Attribute.1.Name'] = 'FifoQueue';
      params['Attribute.1.Value'] = 'true';
      params['Attribute.2.Name'] = 'ContentBasedDeduplication';
      params['Attribute.2.Value'] = 'false';
    }

    const xml = await this.call('CreateQueue', params);

    return readTag(xml, 'QueueUrl') ?? '';
  }

  /** Resolve a URL da fila, lançando se ela não existir. */
  async getQueueUrl(queueName: string): Promise<string> {
    const xml = await this.call('GetQueueUrl', {
      QueueName: queueName,
    });

    return readTag(xml, 'QueueUrl') ?? '';
  }

  /**
   * Cria uma fila FIFO com DLQ e política de redrive — o mesmo desenho do
   * `docker/localstack/init-queues.sh`, com `maxReceiveCount` configurável
   * para os testes de limite de tentativas (§10).
   */
  async createQueueWithDeadLetter(
    queueName: string,
    deadLetterQueueName: string,
    maxReceiveCount: number,
  ): Promise<{ queueUrl: string; deadLetterQueueUrl: string }> {
    const deadLetterQueueUrl = await this.createQueue(deadLetterQueueName, true);

    const attributes = await this.call('GetQueueAttributes', {
      QueueUrl: deadLetterQueueUrl,
      'AttributeName.1': 'QueueArn',
    });

    const deadLetterArn = readTag(attributes, 'Value') ?? '';

    if (!deadLetterArn) {
      throw new Error(
        `Não foi possível obter o ARN da DLQ ${deadLetterQueueName}`,
      );
    }

    const redrivePolicy = JSON.stringify({
      deadLetterTargetArn: deadLetterArn,
      maxReceiveCount: String(maxReceiveCount),
    });

    const xml = await this.call('CreateQueue', {
      QueueName: queueName,
      'Attribute.1.Name': 'FifoQueue',
      'Attribute.1.Value': 'true',
      'Attribute.2.Name': 'ContentBasedDeduplication',
      'Attribute.2.Value': 'false',
      'Attribute.3.Name': 'RedrivePolicy',
      'Attribute.3.Value': redrivePolicy,
    });

    return {
      queueUrl: readTag(xml, 'QueueUrl') ?? '',
      deadLetterQueueUrl,
    };
  }

  async listQueues(): Promise<string[]> {
    const xml = await this.call('ListQueues');

    return [...xml.matchAll(/<QueueUrl>([\s\S]*?)<\/QueueUrl>/g)]
      .map((match) => match[1]!)
      .filter(Boolean);
  }
}

export function createSqsHttp(): SqsHttp {
  return new SqsHttp({
    endpoint: integrationEnv.sqsEndpoint,
    region: integrationEnv.region,
    accessKeyId: integrationEnv.accessKeyId,
    secretAccessKey: integrationEnv.secretAccessKey,
  });
}
