import { EntityManager } from '@mikro-orm/postgresql';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  PublishOutboxMessagesResult,
  PublishOutboxMessagesUseCase,
} from '../../application/messaging/use-cases/publish-outbox-messages.use-case.js';
import { SqsOutboxPublisher } from '../sqs/sqs-outbox-publisher.js';

/** Intervalo padrão entre ciclos. */
export const DEFAULT_OUTBOX_POLL_MS = 5_000;

/** Piso do intervalo: abaixo disso o ciclo vira busy-loop. */
export const MIN_OUTBOX_POLL_MS = 100;

export const OUTBOX_POLL_MS_ENV = 'OUTBOX_POLL_MS';
export const OUTBOX_PUBLISHER_ENABLED_ENV = 'OUTBOX_PUBLISHER_ENABLED';

/**
 * Lê o intervalo de `OUTBOX_POLL_MS`. Valor não numérico, não positivo ou
 * abaixo do piso cai no padrão — configuração errada não pode parar o worker
 * nem transformá-lo em loop ocupado.
 */
export function resolveOutboxPollMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env[OUTBOX_POLL_MS_ENV]);

  return Number.isFinite(parsed) && parsed >= MIN_OUTBOX_POLL_MS
    ? parsed
    : DEFAULT_OUTBOX_POLL_MS;
}

/**
 * Driver agendado da publicação da outbox (README §11): de tempos em tempos
 * aciona `PublishOutboxMessagesUseCase` e registra o desfecho.
 *
 * Mesmo desenho do worker da §7.1 (`PendingReferenceWorker`) — `setInterval`
 * do Nest, sem `@nestjs/schedule`, e quatro responsabilidades apenas:
 *
 * 1. **agendar** o ciclo e impedir sobreposição (um ciclo lento não acumula:
 *    o seguinte é pulado, e nada se perde — a janela está gravada no claim);
 * 2. **não morrer** com a primeira exceção: falha do ciclo é logada e o
 *    próximo tenta de novo;
 * 3. **log estruturado** dos problemas — identificadores e motivo, nunca
 *    payload financeiro (README §12);
 * 4. **desligamento gracioso** (§10/§14): o timer para e o ciclo **em
 *    andamento é aguardado** antes de o processo terminar.
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cycling: Promise<PublishOutboxMessagesResult | null> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly publisher: SqsOutboxPublisher,
  ) {
    this.pollMs = resolveOutboxPollMs();
  }

  onModuleInit(): void {
    if (process.env[OUTBOX_PUBLISHER_ENABLED_ENV] === 'false') {
      this.logger.log(
        `publisher da outbox desabilitado (${OUTBOX_PUBLISHER_ENABLED_ENV}=false)`,
      );

      return;
    }

    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();

    // §10 ("em SIGTERM, concluir mensagens em andamento") e §14 ("shutdown"):
    // o ciclo é curto e, mesmo que o processo morra no meio, a mensagem volta
    // a ser elegível pela janela gravada no claim.
    await this.cycling;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);

    this.logger.log(`publisher da outbox ativo (intervalo ${this.pollMs} ms)`);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Um ciclo completo. `null` significa que o ciclo não chegou a executar
   * (outro em andamento) ou que falhou — em ambos os casos nada foi publicado
   * e o próximo intervalo tenta de novo.
   */
  async tick(
    now: Date = new Date(),
  ): Promise<PublishOutboxMessagesResult | null> {
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

  private async cycle(
    now: Date,
  ): Promise<PublishOutboxMessagesResult | null> {
    try {
      const useCase = new PublishOutboxMessagesUseCase(
        this.em,
        this.publisher,
      );
      const result = await useCase.execute({ now });

      this.report(result);

      return result;
    } catch (error) {
      // Ex.: banco ou SQS indisponível. O claim é uma transação só e a
      // publicação é marcada mensagem a mensagem, então não há estado pela
      // metade: o próximo ciclo tenta de novo.
      this.logger.error(
        `ciclo do publisher da outbox falhou: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );

      return null;
    }
  }

  private report(result: PublishOutboxMessagesResult): void {
    for (const problem of result.problems) {
      this.logger.error(
        `falha ao publicar mensagem da outbox: ${JSON.stringify(problem)}`,
      );
    }

    if (result.claimed > 0) {
      this.logger.log(
        `outbox publicada: ${JSON.stringify({
          claimed: result.claimed,
          published: result.published,
          failed: result.failed,
        })}`,
      );
    }
  }
}
