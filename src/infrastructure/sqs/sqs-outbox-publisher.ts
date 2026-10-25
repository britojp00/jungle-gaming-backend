import {
  OutboxPublisher,
  OutboxPublishing,
} from '../../application/messaging/outbox-publisher.js';
import { SqsClient, SqsClientOptions } from './sqs-client.js';

export interface SqsOutboxPublisherOptions extends SqsClientOptions {
  /**
   * Fila de eventos da outbox (`wager-events.fifo`). É **distinta** da fila de
   * entrada de comandos (`wager-transactions.fifo`, §10): aqui saem os
   * eventos de integração da §11, não os comandos dos provedores.
   */
  queueUrl: string;
}

/**
 * Lê a configuração de SQS do ambiente. `SQS_EVENTS_QUEUE_URL` é a fila de
 * eventos da outbox — **não** confundir com `SQS_WAGER_QUEUE_URL`, que é a
 * fila de comandos recebidos (§10). Região e credenciais são as mesmas.
 */
export function sqsOutboxPublisherOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SqsOutboxPublisherOptions {
  return {
    endpoint: env['SQS_ENDPOINT'] ?? '',
    queueUrl: env['SQS_EVENTS_QUEUE_URL'] ?? '',
    region: env['AWS_REGION'] ?? 'us-east-1',
    accessKeyId: env['AWS_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: env['AWS_SECRET_ACCESS_KEY'] ?? '',
  };
}

/**
 * Publica os eventos da outbox em SQS (README §11).
 *
 * O corpo da mensagem é o envelope **já gravado** em `outbox_messages.payload`
 * — nada é reescrito, então o contrato dos quatro eventos não muda. Como a
 * fila é FIFO, cada envio carrega:
 *
 * - `MessageGroupId` = `aggregateId` (eventos do mesmo agregado preservam a
 *   ordem entre si);
 * - `MessageDeduplicationId` = id da mensagem na outbox (= `eventId`), que
 *   faz o broker absorver reenvios muito próximos do mesmo evento. É
 *   **proteção adicional**: a deduplicação do broker não é a garantia final
 *   de idempotência (README §8) — quem torna uma duplicata segura é o
 *   consumidor, com a Inbox persistente exigida pela §10 (fora desta etapa).
 *
 * Nenhum dos dois substitui a garantia do banco (§5.3): quem impede crédito
 * ou débito duplicado continua sendo a transação financeira.
 */
export class SqsOutboxPublisher implements OutboxPublisher {
  private readonly client: SqsClient;
  private readonly queueUrl: string;

  constructor(
    options: SqsOutboxPublisherOptions = sqsOutboxPublisherOptionsFromEnv(),
  ) {
    if (!options.queueUrl || !options.endpoint) {
      throw new Error(
        'SQS não configurado: defina SQS_EVENTS_QUEUE_URL e SQS_ENDPOINT',
      );
    }

    this.client = new SqsClient({
      endpoint: options.endpoint,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    });
    this.queueUrl = options.queueUrl;
  }

  async publish(message: OutboxPublishing): Promise<void> {
    await this.client.sendMessage({
      queueUrl: this.queueUrl,
      messageBody: JSON.stringify(message.payload),
      messageGroupId: message.aggregateId,
      messageDeduplicationId: message.messageId,
    });
  }
}
