
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './mikro-orm.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthController } from './http/health.controller.js';
import { WalletsController } from './http/wallets.controller.js';
import { WageringController } from './http/wagering.controller.js';
import { HttpExceptionFilter } from './http/http-exception.filter.js';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker.js';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker.js';
import { WagerCommandConsumerWorker } from './infrastructure/workers/wager-command-consumer.worker.js';
import { SqsCommandQueue } from './infrastructure/sqs/sqs-command-queue.js';
import { SqsOutboxPublisher } from './infrastructure/sqs/sqs-outbox-publisher.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [
    AppController,
    WalletsController,
    WageringController,
    HealthController,
  ],
  providers: [
    AppService,
    // Um único mapeamento de status HTTP para todos os endpoints (README §9).
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    PendingReferenceWorker,
    // Publicação da outbox (README §11): o publisher lê a fila e as
    // credenciais do ambiente (`.env.example`), então é montado aqui.
    {
      provide: SqsOutboxPublisher,
      useFactory: () => new SqsOutboxPublisher(),
    },
    OutboxPublisherWorker,
    // Consumidor da fila de comandos (README §10), com Inbox transacional.
    {
      provide: SqsCommandQueue,
      useFactory: () => new SqsCommandQueue(),
    },
    WagerCommandConsumerWorker,
  ],
})
export class AppModule {}
