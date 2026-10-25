import { SqsClient, SqsClientOptions, SqsReceivedMessage } from './sqs-client.js';

export interface SqsCommandQueueOptions extends SqsClientOptions {
  /** Fila de ENTRADA de comandos (§10) — não é a fila de eventos da outbox. */
  queueUrl: string;
  /** DLQ da fila de comandos (§10), para erros permanentes. */
  deadLetterQueueUrl: string;
}

/**
 * Lê a configuração do consumidor no ambiente. `SQS_WAGER_QUEUE_URL` é a
 * fila de **comandos** (§10) e `SQS_WAGER_DLQ_URL` a DLQ dela — a fila de
 * eventos (`SQS_EVENTS_QUEUE_URL`) é da outbox e não entra aqui.
 */
export function sqsCommandQueueOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SqsCommandQueueOptions {
  return {
    endpoint: env['SQS_ENDPOINT'] ?? '',
    queueUrl: env['SQS_WAGER_QUEUE_URL'] ?? '',
    deadLetterQueueUrl: env['SQS_WAGER_DLQ_URL'] ?? '',
    region: env['AWS_REGION'] ?? 'us-east-1',
    accessKeyId: env['AWS_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: env['AWS_SECRET_ACCESS_KEY'] ?? '',
  };
}

/**
 * Fila de comandos dos provedores (README §10).
 *
 * Três operações, nada mais: receber (sem confirmar), confirmar (`ack`) e
 * encaminhar para a DLQ. A confirmação é sempre posterior ao commit da
 * transação — quem decide é o caso de uso do consumidor.
 */
export class SqsCommandQueue {
  private readonly client: SqsClient;
  private readonly queueUrl: string;
  private readonly deadLetterQueueUrl: string;

  constructor(options: SqsCommandQueueOptions = sqsCommandQueueOptionsFromEnv()) {
    if (!options.queueUrl || !options.deadLetterQueueUrl || !options.endpoint) {
      throw new Error(
        'SQS não configurado: defina SQS_WAGER_QUEUE_URL, SQS_WAGER_DLQ_URL e SQS_ENDPOINT',
      );
    }

    this.client = new SqsClient({
      endpoint: options.endpoint,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    });
    this.queueUrl = options.queueUrl;
    this.deadLetterQueueUrl = options.deadLetterQueueUrl;
  }

  receive(
    maxMessages: number,
    visibilityTimeoutSeconds: number,
  ): Promise<SqsReceivedMessage[]> {
    return this.client.receiveMessages({
      queueUrl: this.queueUrl,
      maxMessages,
      waitTimeSeconds: 1,
      visibilityTimeout: visibilityTimeoutSeconds,
    });
  }

  /** `ack` — só depois do commit da transação que processou a mensagem. */
  acknowledge(receiptHandle: string): Promise<void> {
    return this.client.deleteMessage({
      queueUrl: this.queueUrl,
      receiptHandle,
    });
  }

  /**
   * Encaminha o conteúdo original para a DLQ (§10: "permanentes (DLQ)").
   * Com FIFO, cada mensagem morta forma seu próprio grupo e é deduplicada
   * pelo próprio `messageId`.
   */
  forwardToDeadLetter(messageId: string, body: string): Promise<void> {
    return this.client
      .sendMessage({
        queueUrl: this.deadLetterQueueUrl,
        messageBody: body,
        messageGroupId: messageId,
        messageDeduplicationId: messageId,
      })
      .then(() => undefined);
  }
}
