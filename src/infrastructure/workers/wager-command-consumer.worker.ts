import { EntityManager } from '@mikro-orm/postgresql';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import {
  isPermanentConsumerError,
  isInboxDuplicate,
} from '../../application/messaging/consumer-error.js';
import { ReceiveWagerTransactionUseCase } from '../../application/messaging/use-cases/receive-wager-transaction.use-case.js';
import {
  parseWagerTransactionRequested,
  WagerTransactionRequested,
} from '../../application/messaging/wager-transaction-requested.js';
import { SqsCommandQueue } from '../sqs/sqs-command-queue.js';
import type { SqsReceivedMessage } from '../sqs/sqs-client.js';
import { metrics } from '../observability/metrics.js';
import { logEvent } from '../observability/structured-logger.js';

/** Intervalo padrão entre ciclos. */
export const DEFAULT_CONSUMER_POLL_MS = 5_000;

/** Piso do intervalo: abaixo disso o ciclo vira busy-loop. */
export const MIN_CONSUMER_POLL_MS = 100;

export const CONSUMER_POLL_MS_ENV = 'WAGER_CONSUMER_POLL_MS';
export const CONSUMER_ENABLED_ENV = 'WAGER_CONSUMER_ENABLED';

/** Janela de visibilidade padrão: é o intervalo do retry transitório (§10). */
export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;

/** Mensagens por ciclo. */
export const DEFAULT_CONSUMER_BATCH = 10;

export function resolveConsumerPollMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env[CONSUMER_POLL_MS_ENV]);

  return Number.isFinite(parsed) && parsed >= MIN_CONSUMER_POLL_MS
    ? parsed
    : DEFAULT_CONSUMER_POLL_MS;
}

export interface ConsumerCycleResult {
  received: number;
  processed: number;
  replayed: number;
  rejected: number;
  duplicate: number;
  deadLettered: number;
  retried: number;
}

/**
 * Consumidor da fila de **comandos** (README §10).
 *
 * Recebe `WagerTransactionRequested`, processa com os mesmos casos de uso da
 * entrada e **só então** confirma (`ack`). Duas filas distintas: este worker
 * lê `wager-transactions.fifo` e nunca a fila de eventos da outbox.
 *
 * Tratamento conforme §10:
 *
 * - **negócio** (resultado persistido, inclusive `REJECTED`) → ack;
 * - **permanente** (envelope inválido, conflito de idempotência) → envia o
 *   conteúdo original para a DLQ e **só depois** confirma;
 * - **transitório** → não confirma: a reentrega por visibilidade do SQS
 *   assume, e o `maxReceiveCount` da fila leva à DLQ quando o limite vence.
 *
 * Não se alega entrega exactly-once: a garantia é da Inbox persistente, da
 * unique de idempotência e da atomicidade da transação (§5.2, §11).
 */
@Injectable()
export class WagerCommandConsumerWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WagerCommandConsumerWorker.name);
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cycling: Promise<ConsumerCycleResult | null> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly queue: SqsCommandQueue,
    // O valor é configurável (os testes de DLQ usam janela curta). Sem
    // provider para ele, o Nest injeta `undefined` e o padrão vale.
    @Optional()
    private readonly visibilityTimeoutSeconds = DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
  ) {
    this.pollMs = resolveConsumerPollMs();
  }

  onModuleInit(): void {
    if (process.env[CONSUMER_ENABLED_ENV] === 'false') {
      this.logger.log(
        `consumidor de comandos desabilitado (${CONSUMER_ENABLED_ENV}=false)`,
      );

      return;
    }

    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();

    // §10 ("em SIGTERM, concluir mensagens em andamento ou devolver a
    // visibilidade"): o ciclo é aguardado, e o que não foi confirmado volta
    // para a fila pela janela de visibilidade.
    await this.cycling;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);

    this.logger.log(
      `consumidor de comandos ativo (intervalo ${this.pollMs} ms)`,
    );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: Date = new Date()): Promise<ConsumerCycleResult | null> {
    if (this.cycling) {
      return null;
    }

    this.cycling = this.cycle(now);

    try {
      return await this.cycling;
    } finally {
      this.cycling = null;
    }
  }

  private async cycle(now: Date): Promise<ConsumerCycleResult | null> {
    const result: ConsumerCycleResult = {
      received: 0,
      processed: 0,
      replayed: 0,
      rejected: 0,
      duplicate: 0,
      deadLettered: 0,
      retried: 0,
    };

    try {
      const messages = await this.queue.receive(
        DEFAULT_CONSUMER_BATCH,
        this.visibilityTimeoutSeconds,
      );

      result.received = messages.length;

      for (const message of messages) {
        // §12: latência de processamento por mensagem consumida.
        const stopTimer = metrics.startDuration('processing_latency_ms', {
          component: 'consumer',
        });

        await this.handleMessage(message, now, result);
        stopTimer();
      }
    } catch (error) {
      // Banco ou SQS indisponível: nada foi confirmado, então as mensagens
      // voltam pela visibilidade. O próximo ciclo tenta de novo.
      this.logger.error(
        `ciclo do consumidor de comandos falhou: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );

      return null;
    }

    this.report(result);

    return result;
  }

  private async handleMessage(
    message: SqsReceivedMessage,
    now: Date,
    result: ConsumerCycleResult,
  ): Promise<void> {
    let envelope: WagerTransactionRequested;

    try {
      envelope = parseWagerTransactionRequested(JSON.parse(message.body));
    } catch (error) {
      await this.handlePermanent(message, error, result);

      return;
    }

    try {
      // Uma única transação: Inbox + efeitos financeiros + ledger + outbox
      // confirmam juntos (§11). O ack só vem depois dela.
      const outcome = await new ReceiveWagerTransactionUseCase(
        this.em,
      ).execute(envelope, { now });

      // O desfecho é contado assim que a transação confirma; se a
      // confirmação da mensagem falhar depois disso, ela entra em `retried`
      // e volta pela visibilidade — sem efeito novo (a Inbox já garante).
      result[outcome.outcome] += 1;

      if (outcome.outcome === 'duplicate') {
        metrics.increment('duplicates_detected_total', { source: 'inbox' });
      }

      // §12: log estruturado por mensagem, com os identificadores do fluxo —
      // sem payload financeiro. `correlationId` casa com o valor gravado nos
      // eventos da outbox desta transação (§11); quando o desfecho não tem
      // transação (ex.: duplicata da Inbox), o `messageId` faz a correlação.
      logEvent('log', 'command_processed', {
        correlationId: outcome.transactionId ?? message.messageId,
        messageId: message.messageId,
        transactionId: outcome.transactionId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        outcome: outcome.outcome,
        status: outcome.status,
      });

      await this.queue.acknowledge(message.receiptHandle);
    } catch (error) {
      if (isInboxDuplicate(error)) {
        // Outro consumidor já registrou e confirmou esta mensagem: o índice
        // único só acusa depois de a transação concorrente confirmar.
        await this.queue.acknowledge(message.receiptHandle);
        result.duplicate += 1;
        metrics.increment('duplicates_detected_total', { source: 'inbox' });

        return;
      }

      if (isPermanentConsumerError(error)) {
        await this.handlePermanent(message, error, result);

        return;
      }

      // Transitório: NÃO confirmar. A visibilidade do SQS reentrega e o
      // `maxReceiveCount` da fila decide quando vai para a DLQ.
      result.retried += 1;
      metrics.increment('retries_total', { component: 'consumer' });
      logEvent('warn', 'command_retry', {
        correlationId: message.messageId,
        messageId: message.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        reason: error instanceof Error ? error.message : String(error),
      });
      this.logger.error(
        `falha transitória ao processar comando ${message.messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Erro permanente (§10): o conteúdo original vai para a DLQ e a mensagem
   * original só é confirmada **depois** que o encaminhamento funciona.
   */
  private async handlePermanent(
    message: SqsReceivedMessage,
    error: unknown,
    result: ConsumerCycleResult,
  ): Promise<void> {
    await this.queue.forwardToDeadLetter(message.messageId, message.body);
    await this.queue.acknowledge(message.receiptHandle);

    result.deadLettered += 1;
    // §12: mensagens em DLQ, com o motivo — sem o payload financeiro.
    metrics.increment('dlq_messages_total');
    logEvent('error', 'command_dead_lettered', {
      correlationId: message.messageId,
      messageId: message.messageId,
      reason: error instanceof Error ? error.message : String(error),
    });
    this.logger.error(
      `comando ${message.messageId} encaminhado para a DLQ: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private report(result: ConsumerCycleResult): void {
    if (result.received > 0) {
      this.logger.log(
        `comandos consumidos: ${JSON.stringify({
          received: result.received,
          processed: result.processed,
          replayed: result.replayed,
          rejected: result.rejected,
          duplicate: result.duplicate,
          deadLettered: result.deadLettered,
          retried: result.retried,
        })}`,
      );
    }
  }
}
