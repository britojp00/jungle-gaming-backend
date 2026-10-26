import { LoggerService } from '@nestjs/common';

/**
 * Logs estruturados em JSON (README §12), sem payload financeiro completo e
 * sem credenciais: uma linha JSON por evento, com `correlationId`,
 * `messageId`, `transactionId`, `walletId` e `providerId` quando pertinentes.
 *
 * `logEvent` cobre os pontos de ciclo de vida das mensagens (o §12 pede esses
 * campos por evento); `JsonLogger` é o adapter do NestJS que faz todo o
 * restante (framework e workers) também sair em JSON, sem duplicar formato.
 */

export type LogFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export type LogLevel = 'log' | 'warn' | 'error';

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const present = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...present,
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Adapter `LoggerService` do NestJS: mensagens e contexto em JSON. */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, context?: string): void {
    this.write('error', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  private write(level: LogLevel, message: unknown, context?: string): void {
    logEvent(level, typeof message === 'string' ? message : 'log', {
      context,
      detail: typeof message === 'string' ? undefined : stringify(message),
    });
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
