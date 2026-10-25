import { EntityManager } from '@mikro-orm/postgresql';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  ResolvePendingReferencesResult,
  ResolvePendingReferencesUseCase,
} from '../../application/wagering/use-cases/resolve-pending-references.use-case.js';

/** Intervalo padrão entre ciclos. */
export const DEFAULT_PENDING_REFERENCE_POLL_MS = 5_000;

/**
 * Menor intervalo aceito: abaixo disso o ciclo vira busy-loop e compete com o
 * resto da aplicação pela mesma conexão do banco.
 */
export const MIN_PENDING_REFERENCE_POLL_MS = 100;

export const PENDING_REFERENCE_POLL_MS_ENV = 'PENDING_REFERENCE_POLL_MS';
export const PENDING_REFERENCE_ENABLED_ENV = 'PENDING_REFERENCE_WORKER_ENABLED';

/**
 * Lê o intervalo de `PENDING_REFERENCE_POLL_MS`. Qualquer valor não numérico,
 * não positivo ou abaixo do piso cai no padrão — configuração errada não pode
 * parar o worker nem transformá-lo em loop ocupado.
 */
export function resolvePendingReferencePollMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env[PENDING_REFERENCE_POLL_MS_ENV]);

  return Number.isFinite(parsed) && parsed >= MIN_PENDING_REFERENCE_POLL_MS
    ? parsed
    : DEFAULT_PENDING_REFERENCE_POLL_MS;
}

/**
 * Driver agendado do §7.1: de tempos em tempos aciona
 * `ResolvePendingReferencesUseCase` e registra o desfecho.
 *
 * Usa o ciclo de vida do Nest (`onModuleInit`/`onModuleDestroy`) em vez de
 * `@nestjs/schedule`: um único `setInterval` não justifica a dependência, e
 * o timer é limpo no desligamento para não sobreviver ao processo.
 *
 * Deliberadamente fino — quem conhece backoff, TTL, claim e transações é o
 * caso de uso. Aqui ficam só quatro responsabilidades:
 *
 * 1. **agendar** o ciclo e impedir que dois se sobreponham (um ciclo lento
 *    não acumula: o seguinte é pulado, e a fila espera — a janela gravada no
 *    claim já garante que nada se perde);
 * 2. **não morrer** com a primeira exceção: falha do claim é logada e o
 *    próximo ciclo tenta de novo;
 * 3. **log estruturado** dos problemas que o caso de uso devolve — apenas
 *    identificadores e motivos, nunca payload financeiro;
 * 4. **desligamento limpo**, removendo o timer.
 *
 * `tick()` é o ciclo, público e testável: o agendador só o chama.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly em: EntityManager) {
    this.pollMs = resolvePendingReferencePollMs();
  }

  onModuleInit(): void {
    if (process.env[PENDING_REFERENCE_ENABLED_ENV] === 'false') {
      this.logger.log(
        `worker de referências pendentes desabilitado (${PENDING_REFERENCE_ENABLED_ENV}=false)`,
      );

      return;
    }

    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);

    this.logger.log(
      `worker de referências pendentes ativo (intervalo ${this.pollMs} ms)`,
    );
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
   * (outro em andamento) ou que o claim falhou — em ambos os casos nada de
   * estado foi alterado e o próximo intervalo tenta de novo.
   */
  async tick(now: Date = new Date()): Promise<ResolvePendingReferencesResult | null> {
    if (this.running) {
      return null;
    }

    this.running = true;

    try {
      const useCase = new ResolvePendingReferencesUseCase(this.em);
      const result = await useCase.execute({ now });

      this.report(result);

      return result;
    } catch (error) {
      // Ex.: banco indisponível. Não há estado pela metade (o claim é uma
      // transação só), então basta registrar e deixar o próximo ciclo tentar.
      this.logger.error(
        `ciclo do worker de referências falhou: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );

      return null;
    } finally {
      this.running = false;
    }
  }

  private report(result: ResolvePendingReferencesResult): void {
    for (const problem of result.problems) {
      const line = JSON.stringify(problem);

      if (problem.reason === 'UNRESOLVABLE_STATE') {
        this.logger.error(
          `estado inconsistente em linha PENDING_REFERENCE: ${line}`,
        );
      } else {
        this.logger.error(
          `falha ao reprocessar linha PENDING_REFERENCE: ${line}`,
        );
      }
    }

    if (result.claimed > 0) {
      this.logger.log(
        `referências reprocessadas: ${JSON.stringify({
          claimed: result.claimed,
          resolved: result.resolved,
          rejected: result.rejected,
          inconsistent: result.inconsistent,
          stillPending: result.stillPending,
          skipped: result.skipped,
        })}`,
      );
    }
  }
}
