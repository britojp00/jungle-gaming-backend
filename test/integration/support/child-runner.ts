/**
 * Processo independente para os testes de concorrência **entre processos**.
 *
 * Cada execução é um processo `bun` próprio, com sua própria conexão ao
 * PostgreSQL de integração — não é um fork de EntityManager. O protocolo de
 * largada é por stdio: o processo imprime `READY` quando está pronto e espera
 * a linha `GO` antes de executar, para que o teste pai dispare todos ao mesmo
 * tempo sem depender de atrasos arbitrários.
 *
 * Uso: `bun child-runner.ts '{"operation":"bet",...}'` com `DATABASE_URL` no
 * ambiente (as credenciais nunca passam por argv nem aparecem em log).
 */
import { MikroORM } from '@mikro-orm/postgresql';

import {
  ProcessBetInput,
  ProcessBetUseCase,
} from '../../../src/application/wagering/use-cases/process-bet.use-case.js';
import {
  ProcessReversalInput,
  ProcessReversalUseCase,
} from '../../../src/application/wagering/use-cases/process-reversal.use-case.js';
import {
  PublishOutboxMessagesUseCase,
} from '../../../src/application/messaging/use-cases/publish-outbox-messages.use-case.js';
import {
  ReceiveWagerTransactionUseCase,
} from '../../../src/application/messaging/use-cases/receive-wager-transaction.use-case.js';
import {
  parseWagerTransactionRequested,
} from '../../../src/application/messaging/wager-transaction-requested.js';
import { SqsOutboxPublisher } from '../../../src/infrastructure/sqs/sqs-outbox-publisher.js';

interface ChildRequest {
  operation: 'bet' | 'reversal' | 'consume' | 'publish-outbox';
  payload: Record<string, unknown>;
}

function log(result: Record<string, unknown>): void {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}

async function waitForGo(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
    process.stdin.resume();
  });

  // Sem isto, o `stdin` em modo leitura mantém o loop de eventos vivo e o
  // processo nunca termina depois de imprimir o resultado.
  process.stdin.pause();
  process.stdin.unref();
}

async function main(): Promise<void> {
  const request = JSON.parse(process.argv[2] ?? '{}') as ChildRequest;

  const orm = await MikroORM.init({
    clientUrl: process.env['DATABASE_URL'],
    entities: ['./src/**/*.entity.ts'],
    discovery: { warnWhenNoEntities: false },
  });

  try {
    process.stdout.write('READY\n');
    await waitForGo();

    const em = orm.em.fork();

    if (request.operation === 'bet') {
      log(
        (await new ProcessBetUseCase(em).execute(
          request.payload as unknown as ProcessBetInput,
        )) as unknown as Record<string, unknown>,
      );
    } else if (request.operation === 'reversal') {
      log(
        (await new ProcessReversalUseCase(em).execute(
          request.payload as unknown as ProcessReversalInput,
        )) as unknown as Record<string, unknown>,
      );
    } else if (request.operation === 'publish-outbox') {
      // Recuperação por **nova instância** (§11, passos 2-4): a instância
      // anterior confirmou os efeitos financeiros e terminou sem publicar;
      // este processo, com conexões próprias, drena a outbox para o SQS real.
      // Credenciais e endpoint vêm do ambiente (§ segredos: nunca por argv).
      const queueUrl: unknown = request.payload['queueUrl'];
      const publisher = new SqsOutboxPublisher({
        endpoint: process.env['SQS_ENDPOINT'] ?? '',
        queueUrl: typeof queueUrl === 'string' ? queueUrl : '',
        region: process.env['AWS_REGION'] ?? 'us-east-1',
        accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
      });
      const result = await new PublishOutboxMessagesUseCase(
        em,
        publisher,
      ).execute({});

      log({
        claimed: result.claimed,
        published: result.published,
        failed: result.failed,
      });
    } else {
      // Fluxo real do consumidor (§10) SEM o ack: é exatamente o estado em
      // que o processo morre depois do commit financeiro e antes da
      // confirmação da mensagem.
      const envelope = parseWagerTransactionRequested(request.payload);
      const outcome = await new ReceiveWagerTransactionUseCase(em).execute(
        envelope,
      );
      log({ outcome: outcome.outcome, transactionId: outcome.transactionId });
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  log({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
