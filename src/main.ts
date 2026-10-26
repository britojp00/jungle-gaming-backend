import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { JsonLogger } from './infrastructure/observability/structured-logger.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Logs estruturados em JSON (README §12): framework e workers saem no
  // mesmo formato, sem payload financeiro completo.
  app.useLogger(new JsonLogger());
  // Desligamento gracioso (README §10/§14): em SIGTERM/SIGINT o NestJS chama
  // `onModuleDestroy` dos workers — o `OutboxPublisherWorker` aguarda o ciclo
  // de publicação em andamento antes de o processo terminar.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
