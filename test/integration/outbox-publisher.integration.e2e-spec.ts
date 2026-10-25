import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import {
  OutboxPublisher,
  OutboxPublishing,
} from '../../src/application/messaging/outbox-publisher.js';
import { PublishOutboxMessagesUseCase } from '../../src/application/messaging/use-cases/publish-outbox-messages.use-case.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { OutboxMessageEntity } from '../../src/infrastructure/persistence/entities/outbox-message.entity.js';
import { SqsOutboxPublisher } from '../../src/infrastructure/sqs/sqs-outbox-publisher.js';
import { OpenWalletUseCase } from '../../src/application/wallets/use-cases/open-wallet.use-case.js';
import {
  ProcessBetInput,
  ProcessBetUseCase,
} from '../../src/application/wagering/use-cases/process-bet.use-case.js';
import {
  ProcessWinInput,
  ProcessWinUseCase,
} from '../../src/application/wagering/use-cases/process-win.use-case.js';
import { integrationEnv } from './support/env.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';
import { createSqsHttp, type SqsHttp } from './support/sqs.js';

/**
 * Publicação da Transactional Outbox (README §11) contra **PostgreSQL e
 * LocalStack reais** — nada de mock de SQS (§13).
 *
 * Cenários exigidos:
 * 1. evento persistido na MESMA transação dos efeitos financeiros;
 * 2. recuperação após interrupção **antes** da publicação;
 * 3. dois publishers concorrentes sem perda nem claim simultâneo indevido;
 * 4. falha de publicação e retentativa;
 * 5. rollback da transação financeira não deixa evento para publicar.
 *
 * Em todos: o corpo publicado é o payload gravado, sem alteração de conteúdo
 * (as comparações são entre objetos JSON parseados, não entre bytes).
 *
 * O que NÃO se alega aqui: "exatamente uma vez". O que fica comprovado é que
 * dois publishers concorrentes não levam a mesma mensagem (claim único) e que
 * nada se perde. Um reenvio do mesmo evento (queda entre publicar e marcar)
 * pode chegar ao consumidor — a deduplicação FIFO do SQS é proteção adicional
 * e a segurança de efeitos duplicados é do consumidor/Inbox (§10), que ainda
 * não existe.
 */

let orm: MikroORM;
let sqs: SqsHttp;
/** Fila de eventos da outbox (§11) — o publisher publica AQUI. */
let eventsQueueUrl: string;
/** Fila de comandos (§10) — nada da outbox pode aparecer nela. */
let commandQueueUrl: string;

beforeAll(async () => {
  orm = await bootstrapIntegrationOrm();
  sqs = createSqsHttp();
  eventsQueueUrl = await sqs.createQueue(integrationEnv.sqsEventsQueueName, true);
  commandQueueUrl = await sqs.createQueue(integrationEnv.sqsQueueName, true);
}, 60_000);

afterAll(async () => {
  await disposeIntegrationOrm();
});

beforeEach(async () => {
  await truncateIntegrationTables();
  // As filas não são truncadas pelo harness: cada teste começa com as duas vazias.
  await sqs.call('PurgeQueue', { QueueUrl: eventsQueueUrl });
  await sqs.call('PurgeQueue', { QueueUrl: commandQueueUrl });
});

function instanceEm(): EntityManager {
  return orm.em.fork();
}

function publish(
  now: Date,
  publisher: OutboxPublisher,
  em: EntityManager = instanceEm(),
) {
  return new PublishOutboxMessagesUseCase(em, publisher).execute({ now });
}

function realPublisher(): SqsOutboxPublisher {
  return new SqsOutboxPublisher({
    endpoint: integrationEnv.sqsEndpoint,
    queueUrl: eventsQueueUrl,
    region: integrationEnv.region,
    accessKeyId: integrationEnv.accessKeyId,
    secretAccessKey: integrationEnv.secretAccessKey,
  });
}

/** Registra o que foi enviado, delegando ao SQS de verdade. */
class RecordingPublisher implements OutboxPublisher {
  readonly sent: OutboxPublishing[] = [];
  failing = false;

  constructor(private readonly delegate: OutboxPublisher) {}

  async publish(message: OutboxPublishing): Promise<void> {
    this.sent.push(message);

    if (this.failing) {
      throw new Error('SIMULATED_SQS_OUTAGE');
    }

    await this.delegate.publish(message);
  }
}

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

/** `timestamptz` lido por SQL cru volta como string literal do Postgres. */
function dateOf(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  return new Date(
    String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
  );
}

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  published_at: string | null;
}

async function readOutboxRows(): Promise<OutboxRow[]> {
  return (await orm.em.getConnection().execute(
    `select id, event_type, aggregate_id, payload, status, attempts,
            next_attempt_at, last_error, published_at
       from outbox_messages order by created_at`,
  )) as OutboxRow[];
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Consome o que o SQS realmente recebeu (por padrão, a fila de eventos). */
async function receiveMessages(
  queue: string = eventsQueueUrl,
): Promise<Array<{ messageId: string; body: Record<string, unknown> }>> {
  const xml = await sqs.call('ReceiveMessage', {
    QueueUrl: queue,
    MaxNumberOfMessages: '10',
    WaitTimeSeconds: '1',
  });

  return [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((match) => {
    const block = match[1]!;

    return {
      messageId:
        /<MessageId>([\s\S]*?)<\/MessageId>/.exec(block)?.[1] ?? '',
      body: JSON.parse(
        unescapeXml(/<Body>([\s\S]*?)<\/Body>/.exec(block)?.[1] ?? ''),
      ) as Record<string, unknown>,
    };
  });
}

/**
 * EM cujo `flush` falha DEPOIS de escrever as linhas e ANTES do commit, mas
 * apenas quando uma `OutboxMessageEntity` já foi persistida — o ponto em que
 * a atomicidade precisa valer (§11: ou tudo confirma junto, ou nada).
 */
function emWithForcedPostFlushFailure(): EntityManager {
  const real = orm.em.fork();

  const failingTx = (
    txEm: EntityManager,
    state: { outboxPersisted: boolean },
  ): EntityManager =>
    new Proxy(txEm, {
      get(target, property) {
        if (property === 'persist') {
          return (entity: Parameters<EntityManager['persist']>[0]) => {
            if (entity instanceof OutboxMessageEntity) {
              state.outboxPersisted = true;
            }

            return target.persist(entity);
          };
        }

        if (property === 'flush') {
          return async (): Promise<void> => {
            await target.flush();

            if (state.outboxPersisted) {
              throw new Error('FORCED_FAILURE_AFTER_OUTBOX_FLUSH');
            }
          };
        }

        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(real, {
    get(target, property) {
      if (property === 'transactional') {
        return (cb: (em: EntityManager) => Promise<unknown>) => {
          const state = { outboxPersisted: false };

          return target.transactional((txEm) => cb(failingTx(txEm, state)));
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as EntityManager;
}

/**
 * O processo morre DEPOIS de o claim confirmar e ANTES de publicar: a
 * transação do claim está confirmada e nenhuma publicação acontece.
 */
function emThatDiesAfterTheClaim(): EntityManager {
  const real = orm.em.fork();

  return new Proxy(real, {
    get(target, property) {
      if (property === 'transactional') {
        return async (cb: (em: EntityManager) => Promise<unknown>) => {
          await target.transactional(cb);

          throw new Error('FORCED_PROCESS_DEATH_AFTER_CLAIM');
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as EntityManager;
}

async function openWallet(
  playerId: string,
  initialAmount: string,
): Promise<{ id: string; version: number }> {
  return new OpenWalletUseCase(instanceEm()).execute({
    playerId,
    initialBalance: Money.from({ amount: initialAmount, currency: 'BRL' }),
  });
}

function winInput(walletId: string, playerId: string): ProcessWinInput {
  const id = randomUUID();

  return {
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: `win-${id}`,
    idempotencyKey: `key-win-${id}`,
    amount: '25.00',
    currency: 'BRL',
    roundId: 'round-shared',
    gameId: 'fortune-chimp',
  };
}

function processWin(input: ProcessWinInput): Promise<unknown> {
  return new ProcessWinUseCase(instanceEm()).execute(input);
}

function betInput(walletId: string, playerId: string): ProcessBetInput {
  const id = randomUUID();

  return {
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: `bet-${id}`,
    idempotencyKey: `key-bet-${id}`,
    amount: '10.00',
    currency: 'BRL',
    roundId: 'round-a',
    gameId: 'fortune-chimp',
  };
}

function processBet(input: ProcessBetInput): Promise<unknown> {
  return new ProcessBetUseCase(instanceEm()).execute(input);
}

describe('Outbox (§11) — evento e publicação', () => {
  it('persiste o evento na mesma transação dos efeitos e publica o payload inalterado', async () => {
    const playerId = `it-outbox-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await processWin(winInput(wallet.id, playerId));

    const rows = await readOutboxRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true);

    // O envelope gravado é o contrato dos eventos (§11): nada é reescrito.
    for (const row of rows) {
      expect(row.payload['eventId']).toBe(row.id);
      expect(row.payload['eventType']).toBe(row.event_type);
      expect(row.payload['aggregateId']).toBe(row.aggregate_id);
    }

    const publisher = new RecordingPublisher(realPublisher());
    const result = await publish(new Date(), publisher);

    expect(result).toMatchObject({
      claimed: rows.length,
      published: rows.length,
      failed: 0,
      problems: [],
    });

    const published = await readOutboxRows();
    expect(published.every((row) => row.status === 'PUBLISHED')).toBe(true);
    expect(
      published.every((row) => row.published_at !== null && row.attempts === 1),
    ).toBe(true);

    // O que o SQS recebeu tem o mesmo conteúdo do que estava gravado.
    const received = await receiveMessages();
    expect(received).toHaveLength(rows.length);

    const bodies = received.map((message) => message.body).sort(byEventId);
    const stored = rows.map((row) => row.payload).sort(byEventId);
    expect(bodies).toEqual(stored);
  }, 30_000);

  it('publica na fila de eventos dedicada e nada cai na fila de comandos', async () => {
    const playerId = `it-outbox-queue-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await processWin(winInput(wallet.id, playerId));

    const rows = await readOutboxRows();
    const publisher = new RecordingPublisher(realPublisher());
    const result = await publish(new Date(), publisher);

    expect(result).toMatchObject({
      claimed: rows.length,
      published: rows.length,
      failed: 0,
    });

    // A fila de eventos recebe tudo…
    expect(await receiveMessages(eventsQueueUrl)).toHaveLength(rows.length);

    // …e a fila de entrada de comandos (§10) não recebe nada da outbox:
    // comandos dos provedores e eventos de integração são fluxos distintos.
    expect(await receiveMessages(commandQueueUrl)).toEqual([]);
  }, 30_000);

  it('publica os quatro tipos de evento exigidos pela §11', async () => {
    const playerId = `it-outbox-events-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // Abertura → `WalletBalanceChanged`.
    const bet = betInput(wallet.id, playerId);

    // BET aplicada → `WagerTransactionProcessed` + `WalletBalanceChanged`.
    await processBet(bet);

    // WIN sem referência → crédito imediato: `WagerTransactionProcessed` +
    // `WalletBalanceChanged`.
    await processWin(winInput(wallet.id, playerId));

    // Referência ausente (regra 8) → `WagerTransactionPendingReference`.
    await processWin({
      ...winInput(wallet.id, playerId),
      referenceExternalTransactionId: 'bet-missing',
    });

    // Referência que viola a regra 2 (rodada divergente) → `WagerTransactionRejected`.
    await processWin({
      ...winInput(wallet.id, playerId),
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: 'round-b',
    });

    const rows = await readOutboxRows();
    const types = [...new Set(rows.map((row) => row.event_type))].sort();

    expect(types).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
    ]);

    const publisher = new RecordingPublisher(realPublisher());
    const result = await publish(new Date(), publisher);

    expect(result).toMatchObject({
      claimed: rows.length,
      published: rows.length,
      failed: 0,
    });

    const received = await receiveMessages();
    expect(received).toHaveLength(rows.length);
    expect(
      [...new Set(received.map((message) => message.body['eventType']))].sort(),
    ).toEqual(types);
  }, 30_000);

  it('recupera a mensagem pendente após interrupção ANTES da publicação', async () => {
    const playerId = `it-outbox-crash-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await processWin(winInput(wallet.id, playerId));

    const rows = await readOutboxRows();
    const total = rows.length;
    const t0 = new Date();

    // O processo morre logo depois de o claim confirmar: nada é publicado.
    const dying = new RecordingPublisher(realPublisher());
    await expect(
      publish(t0, dying, emThatDiesAfterTheClaim()),
    ).rejects.toThrow('FORCED_PROCESS_DEATH_AFTER_CLAIM');

    expect(dying.sent).toEqual([]);
    expect(await receiveMessages()).toEqual([]);

    // A mensagem não se perde: segue `PENDING`, com tentativa e janela já
    // gravadas no claim — é o que faz o próximo ciclo encontrá-la.
    const claimed = await readOutboxRows();
    expect(claimed).toHaveLength(total);

    for (const row of claimed) {
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(1);
      expect(row.published_at).toBeNull();
      expect(dateOf(row.next_attempt_at).getTime()).toBe(t0.getTime() + 5_000);
    }

    // Outra instância assume o trabalho na janela seguinte (§11, passos 2-4).
    const publisher = new RecordingPublisher(realPublisher());
    const result = await publish(at(t0, 60_000), publisher);

    expect(result).toMatchObject({
      claimed: total,
      published: total,
      failed: 0,
    });

    const received = await receiveMessages();
    expect(received).toHaveLength(total);
  }, 30_000);

  it('dois publishers concorrentes dividem o lote sem duplicar nem perder mensagens', async () => {
    const playerId = `it-outbox-parallel-${randomUUID()}`;
    const wallet = await openWallet(playerId, '1000.00');

    for (let index = 0; index < 3; index++) {
      await processWin(winInput(wallet.id, playerId));
    }

    const total = (await readOutboxRows()).length;
    const t0 = new Date();

    const publisher = new RecordingPublisher(realPublisher());
    const [first, second] = await Promise.all([
      publish(t0, publisher),
      publish(t0, publisher),
    ]);

    // `FOR UPDATE SKIP LOCKED` + janela no claim: os dois não levam a mesma
    // mensagem, e nada fica para trás.
    expect(first.claimed + second.claimed).toBe(total);
    expect(first.published + second.published).toBe(total);
    expect(first.failed + second.failed).toBe(0);

    // Sem claim duplo: cada mensagem foi levada por apenas UM destes
    // publishers. Isso NÃO alega entrega "exatamente uma vez" — um reenvio
    // posterior do mesmo evento (queda entre publicar e marcar) continua
    // possível, e torná-lo seguro é tarefa do consumidor/Inbox (§10).
    const sentIds = publisher.sent.map((message) => message.messageId);
    expect(sentIds).toHaveLength(total);
    expect(new Set(sentIds).size).toBe(total);

    expect((await receiveMessages()).map((m) => m.body).sort(byEventId)).toEqual(
      (await readOutboxRows()).map((row) => row.payload).sort(byEventId),
    );
  }, 30_000);

  it('falha de publicação vira retentativa e a mensagem sai no ciclo seguinte', async () => {
    const playerId = `it-outbox-retry-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await processWin(winInput(wallet.id, playerId));

    const total = (await readOutboxRows()).length;
    const t0 = new Date();

    const publisher = new RecordingPublisher(realPublisher());
    publisher.failing = true;

    const failed = await publish(t0, publisher);

    expect(failed).toMatchObject({ claimed: total, published: 0, failed: total });
    expect(failed.problems).toHaveLength(total);

    for (const problem of failed.problems) {
      expect(problem).toMatchObject({
        reason: 'PUBLISH_FAILED',
        detail: 'SIMULATED_SQS_OUTAGE',
      });
    }

    const afterFailure = await readOutboxRows();
    for (const row of afterFailure) {
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('SIMULATED_SQS_OUTAGE');
      expect(row.published_at).toBeNull();
      expect(dateOf(row.next_attempt_at).getTime()).toBe(t0.getTime() + 5_000);
    }

    expect(await receiveMessages()).toEqual([]);

    // Retentativa dentro da janela seguinte: sai e é marcada PUBLISHED.
    publisher.failing = false;
    const retried = await publish(at(t0, 60_000), publisher);

    expect(retried).toMatchObject({ claimed: total, published: total });
    expect((await receiveMessages()).map((m) => m.body).sort(byEventId)).toEqual(
      (await readOutboxRows()).map((row) => row.payload).sort(byEventId),
    );
  }, 30_000);

  it('rollback da transação financeira não deixa evento para publicar', async () => {
    const playerId = `it-outbox-rollback-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const before = await readOutboxRows();
    const beforeIds = before.map((row) => row.id).sort();

    const input = winInput(wallet.id, playerId);

    await expect(
      new ProcessWinUseCase(emWithForcedPostFlushFailure()).execute(input),
    ).rejects.toThrow('FORCED_FAILURE_AFTER_OUTBOX_FLUSH');

    // Nada do que sofreu rollback chega à outbox (§11: ou tudo, ou nada).
    const after = await readOutboxRows();
    expect(after.map((row) => row.id).sort()).toEqual(beforeIds);

    const publisher = new RecordingPublisher(realPublisher());
    const result = await publish(new Date(), publisher);

    expect(result).toMatchObject({
      claimed: beforeIds.length,
      published: beforeIds.length,
    });

    // Nem o que foi publicado veio da transação desfeita.
    const received = await receiveMessages();
    expect(received.map((message) => message.body['eventId']).sort()).toEqual(
      beforeIds,
    );
  }, 30_000);
});

function byEventId(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return String(left['eventId']).localeCompare(String(right['eventId']));
}
