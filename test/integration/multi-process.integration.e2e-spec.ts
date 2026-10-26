import { randomUUID } from 'node:crypto';
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MikroORM } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/application/wallets/use-cases/open-wallet.use-case.js';
import { ProcessBetUseCase } from '../../src/application/wagering/use-cases/process-bet.use-case.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { SqsCommandQueue } from '../../src/infrastructure/sqs/sqs-command-queue.js';
import { SqsClient } from '../../src/infrastructure/sqs/sqs-client.js';
import { integrationEnv } from './support/env.js';
import { createSqsHttp } from './support/sqs.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';

/**
 * Concorrência **entre processos independentes** (§8 e §13.4).
 *
 * Cada concorrente é um processo `bun` próprio (`support/child-runner.ts`),
 * com conexão própria ao mesmo PostgreSQL de integração — não é um fork de
 * EntityManager dentro do processo de teste. A largada é sincronizada por
 * stdio: cada filho sinaliza `READY` e espera `GO`, então não há `sleep`
 * arbitrário provocando a corrida.
 */

const RUNNER = fileURLToPath(new URL('./support/child-runner.ts', import.meta.url));

let orm: MikroORM;

beforeAll(async () => {
  orm = await bootstrapIntegrationOrm();
}, 60_000);

afterAll(async () => {
  await disposeIntegrationOrm();
});

beforeEach(async () => {
  await truncateIntegrationTables();
});

interface ChildResult {
  [key: string]: unknown;
}

/**
 * Binário do Bun: a suíte roda em processos Node do Vitest
 * (`process.execPath` seria `node`), e as crianças precisam do Bun para
 * importar TypeScript com `enum`. Resolvido uma única vez pelo PATH.
 */
const BUN = execFileSync(
  process.platform === 'win32' ? 'where' : 'which',
  ['bun'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)[0]!;

function spawnChild(payload: Record<string, unknown>): ChildProcessWithoutNullStreams {
  // O DATABASE_URL e as credenciais SQS vão pelo ambiente — nada em argv ou log.
  return spawn(BUN, [RUNNER, JSON.stringify(payload)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: integrationEnv.databaseUrl,
      SQS_ENDPOINT: integrationEnv.sqsEndpoint,
      AWS_REGION: integrationEnv.region,
      AWS_ACCESS_KEY_ID: integrationEnv.accessKeyId,
      AWS_SECRET_ACCESS_KEY: integrationEnv.secretAccessKey,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Dispara N processos com largada simultânea e devolve o resultado de cada um. */
async function runProcesses(
  requests: Array<Record<string, unknown>>,
): Promise<ChildResult[]> {
  const children = requests.map(spawnChild);
  const stdout: string[] = children.map(() => '');
  const stderr: string[] = children.map(() => '');
  const results: ChildResult[] = children.map(() => ({}));

  try {
    children.forEach((child, index) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout[index] += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr[index] += chunk.toString();
      });
    });

    // Barreira: todos precisam estar prontos antes da largada.
    // Event-driven (sem polling): cada filho sinaliza `READY` no próprio stdout
    // e a largada só sai depois que todos chegaram lá.
    const ready = children.map((child, index) => {
      const captured = { out: '' };

      return new Promise<void>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          captured.out += chunk.toString();

          if (captured.out.includes('READY')) {
            resolve();
          }
        };

        child.stdout.on('data', onData);

        child.on('exit', (code) => {
          reject(
            new Error(
              `processo ${index} terminou antes da largada (exit ${code})`,
            ),
          );
        });

        child.on('error', (error) => {
          reject(new Error(`processo ${index} não iniciou: ${error.message}`));
        });
      });
    });

    await Promise.race([
      Promise.all(ready),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `DEADLINE_BARRIER: ${children.length} processos não sinalizaram READY`,
              ),
            ),
          20_000,
        ),
      ),
    ]);

    // Largada simultânea.
    for (const child of children) {
      child.stdin.write('GO\n');
    }

    // Promessas de saída registradas JÁ no spawn: uma criança rápida pode
    // terminar antes de qualquer handler anexado depois da largada.
    const exits = children.map((child) =>
      new Promise<number>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode ?? -1);

          return;
        }

        child.on('exit', (code) => resolve(code ?? -1));
        child.on('error', () => resolve(-1));
      }),
    );

    const codes = await Promise.all(exits);

    codes.forEach((code, index) => {
      expect(code, `processo ${index} falhou: ${stderr[index]}`).toBe(0);
    });

    children.forEach((child, index) => {
      const line = stdout[index]!
        .split('\n')
        .find((candidate) => candidate.startsWith('RESULT '));

      results[index] = JSON.parse(line!.slice('RESULT '.length)) as ChildResult;
    });

    return results;
  } finally {
    // Nunca deixar processos filhos órfãos.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }
  }
}

async function openWallet(
  playerId: string,
  initialAmount: string,
): Promise<{ id: string }> {
  return new OpenWalletUseCase(orm.em.fork()).execute({
    playerId,
    initialBalance: Money.from({ amount: initialAmount, currency: 'BRL' }),
  });
}

function betPayload(walletId: string, playerId: string, amount: string) {
  return {
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: `bet-${randomUUID()}`,
    idempotencyKey: `key-${randomUUID()}`,
    amount,
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
  };
}

/**
 * Invariante final exigida pela §13 (`wallet.balance == saldo reconstruído
 * pelo ledger`), calculada de forma independente: lê os lançamentos por SQL e
 * reconstrói o saldo com `Money` (sem ponto flutuante).
 */
async function expectWalletReconciled(walletId: string): Promise<void> {
  const stored = Money.from({
    amount: (await walletRow(walletId)).balance,
    currency: 'BRL',
  });
  const entries = (await readRows(
    `select direction, amount, currency from wallet_ledger_entries
      where wallet_id = '${walletId}' order by created_at, id`,
  )) as Array<{ direction: string; amount: string; currency: string }>;

  let reconstructed = Money.zero('BRL');

  for (const entry of entries) {
    const amount = Money.from({
      amount: entry.amount,
      currency: entry.currency,
    });
    reconstructed =
      entry.direction === 'CREDIT'
        ? reconstructed.add(amount)
        : reconstructed.subtract(amount);
  }

  expect(reconstructed.equals(stored)).toBe(true);
}

function reversalPayload(
  kind: 'REFUND' | 'ROLLBACK',
  walletId: string,
  playerId: string,
  amount: string,
  reference: string,
) {
  return {
    kind,
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: `rev-${randomUUID()}`,
    idempotencyKey: `key-${randomUUID()}`,
    amount,
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    referenceExternalTransactionId: reference,
  };
}

interface Row {
  [key: string]: unknown;
}

async function readRows(sql: string): Promise<Row[]> {
  return (await orm.em.getConnection().execute(sql)) as Row[];
}

async function walletRow(walletId: string) {
  const rows = (await readRows(
    `select balance, version from wallets where id = '${walletId}'`,
  )) as Array<{ balance: string; version: number }>;

  return rows[0]!;
}

describe('Concorrência entre processos independentes (§8)', () => {
  it('duas apostas de 80.00 em processos distintos: uma aprovada, saldo 20.00', async () => {
    const playerId = `mp-race-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const results = await runProcesses([
      { operation: 'bet', payload: betPayload(wallet.id, playerId, '80.00') },
      { operation: 'bet', payload: betPayload(wallet.id, playerId, '80.00') },
    ]);

    const statuses = results
      .map((result) => result['status'])
      .sort((a, b) => String(a).localeCompare(String(b)));
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const rejected = results.find((result) => result['status'] === 'REJECTED')!;
    expect(rejected['failureCode']).toBe('INSUFFICIENT_FUNDS');

    // Estado persistido: um único efeito financeiro.
    const walletState = await walletRow(wallet.id);
    expect(walletState.balance).toBe('20.00');
    expect(walletState.version).toBe(2);

    const debits = (
      await readRows(
        `select * from wallet_ledger_entries where wallet_id = '${wallet.id}' and direction = 'DEBIT'`,
      )
    ) as Array<{ amount: string }>;
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe('80.00');

    const bets = await readRows(
      `select status from wager_transactions where wallet_id = '${wallet.id}' and kind = 'BET'`,
    );
    expect(bets).toHaveLength(2);
    expect(
      bets
        .map((row) => row['status'])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['PROCESSED', 'REJECTED']);

    const outbox = await readRows(
      `select event_type from outbox_messages where event_type = 'WalletBalanceChanged'`,
    );
    expect(outbox).toHaveLength(2); // abertura + a aprovada
  }, 60_000);

  it('REFUND e ROLLBACK em processos distintos: uma reversão só, perdedor auditado', async () => {
    const playerId = `mp-reversal-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const betExternal = `bet-${randomUUID()}`;
    await new ProcessBetUseCase(orm.em.fork()).execute({
      ...betPayload(wallet.id, playerId, '30.00'),
      externalTransactionId: betExternal,
    });

    const results = await runProcesses([
      {
        operation: 'reversal',
        payload: reversalPayload(
          'REFUND',
          wallet.id,
          playerId,
          '30.00',
          betExternal,
        ),
      },
      {
        operation: 'reversal',
        payload: reversalPayload(
          'ROLLBACK',
          wallet.id,
          playerId,
          '30.00',
          betExternal,
        ),
      },
    ]);

    const applied = results.filter((result) => result['status'] === 'PROCESSED');
    expect(applied).toHaveLength(1);

    // O perdedor vira REJECTED auditado, com o failureCode do contrato.
    const loser = results.find((result) => result['status'] !== 'PROCESSED')!;
    expect(loser['status']).toBe('REJECTED');
    expect(loser['failureCode']).toBe('REFERENCE_ALREADY_REVERSED');

    // Nenhum crédito duplicado.
    expect((await walletRow(wallet.id)).balance).toBe('100.00');

    const audited = await readRows(
      `select status, rejection_reason from wager_transactions
        where kind in ('REFUND','ROLLBACK') and status = 'REJECTED'`,
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]!['rejection_reason']).toBe('REFERENCE_ALREADY_REVERSED');
  }, 60_000);
});

describe('Redelivery de comando sem duplicar efeitos (§10)', () => {
  it('processo confirma o efeito e morre antes do ACK: a reentrega não duplica nada', async () => {
    const playerId = `mp-redelivery-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    // Fila real de comandos + DLQ (o consumidor exige as duas URLs).
    const admin = createSqsHttp();
    const queue = await admin.createQueueWithDeadLetter(
      `jungle-integration-mp-${randomUUID().slice(0, 8)}.fifo`,
      `jungle-integration-mp-dlq-${randomUUID().slice(0, 8)}.fifo`,
      2,
    );

    const client = new SqsClient({
      endpoint: integrationEnv.sqsEndpoint,
      region: integrationEnv.region,
      accessKeyId: integrationEnv.accessKeyId,
      secretAccessKey: integrationEnv.secretAccessKey,
    });

    const envelope = {
      messageId: `msg-${randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: `transaction-${randomUUID()}`,
        idempotencyKey: `key-${randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    await client.sendMessage({
      queueUrl: queue.queueUrl,
      messageBody: JSON.stringify(envelope),
      messageGroupId: randomUUID(),
      messageDeduplicationId: randomUUID(),
    });

    // Processo 1: fluxo real do consumidor (receive → Inbox + efeitos) e
    // SAÍDA antes do ACK — é o "morto entre o commit e a confirmação".
    const first = await runProcesses([
      {
        operation: 'consume',
        payload: envelope,
      },
    ]);
    expect(first[0]!['outcome']).toBe('processed');

    const queueClient = new SqsCommandQueue({
      endpoint: integrationEnv.sqsEndpoint,
      queueUrl: queue.queueUrl,
      deadLetterQueueUrl: queue.deadLetterQueueUrl,
      region: integrationEnv.region,
      accessKeyId: integrationEnv.accessKeyId,
      secretAccessKey: integrationEnv.secretAccessKey,
    });

    // A mensagem voltou para a fila: mesma entrega, outro consumidor.
    // Visibilidade não nula: com 0 o `receipt handle` expira e o ACK falha.
    const redelivered = await queueClient.receive(1, 30);
    expect(redelivered).toHaveLength(1);

    const second = await runProcesses([
      { operation: 'consume', payload: envelope },
    ]);
    expect(second[0]!['outcome']).toBe('duplicate');

    await queueClient.acknowledge(redelivered[0]!.receiptHandle);

    // Redelivery sem duplicar saldo, ledger nem eventos financeiros.
    expect((await walletRow(wallet.id)).balance).toBe('75.00');
    expect(
      await readRows(
        `select * from wallet_ledger_entries where wallet_id = '${wallet.id}'`,
      ),
    ).toHaveLength(2); // abertura + BET

    const events = await readRows(
      `select event_type from outbox_messages`,
    );
    expect(
      events.filter((row) => row['event_type'] === 'WalletBalanceChanged'),
    ).toHaveLength(2); // abertura + a BET

    const inbox = await readRows(`select * from inbox_messages`);
    expect(inbox).toHaveLength(1);
  }, 60_000);
});

describe('≥3 processos simultâneos (§13.4)', () => {
  it('quatro processos disputam o mesmo saldo: um débito só, saldo 20.00', async () => {
    const playerId = `mp-three-plus-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const results = await runProcesses(
      Array.from({ length: 4 }, () => ({
        operation: 'bet',
        payload: betPayload(wallet.id, playerId, '80.00'),
      })),
    );

    // Exatamente uma aposta processada; as demais, por saldo insuficiente.
    const processed = results.filter((result) => result['status'] === 'PROCESSED');
    const rejected = results.filter((result) => result['status'] === 'REJECTED');
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(3);

    for (const result of rejected) {
      expect(result['failureCode']).toBe('INSUFFICIENT_FUNDS');
    }

    const walletState = await walletRow(wallet.id);
    expect(walletState.balance).toBe('20.00');

    const debits = (await readRows(
      `select amount from wallet_ledger_entries
        where wallet_id = '${wallet.id}' and direction = 'DEBIT'`,
    )) as Array<{ amount: string }>;
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe('80.00');

    // §13: invariante final — saldo materializado == ledger reconstruído.
    await expectWalletReconciled(wallet.id);
  }, 60_000);
});

describe('Recuperação após queda da instância (§11, passos 2-4; §13)', () => {
  it('instância morre após o commit; nova instância publica o pendente e o estado reconcilia', async () => {
    const playerId = `mp-recovery-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const admin = createSqsHttp();
    const eventsQueueUrl = await admin.createQueue(
      `jungle-integration-mp-events-${randomUUID().slice(0, 8)}.fifo`,
      true,
    );

    // Instância 1: aplica a BET e **termina** — o commit aconteceu e a
    // publicação não (é o estado de quem morre entre o commit e o publish).
    const first = await runProcesses([
      { operation: 'bet', payload: betPayload(wallet.id, playerId, '25.00') },
    ]);
    expect(first[0]!['status']).toBe('PROCESSED');

    const pending = await readRows(
      `select status, event_type from outbox_messages`,
    );
    expect(pending.length).toBeGreaterThan(0);
    for (const row of pending) {
      expect(row['status']).toBe('PENDING');
    }

    // O broker ainda não recebeu nada.
    const client = new SqsClient({
      endpoint: integrationEnv.sqsEndpoint,
      region: integrationEnv.region,
      accessKeyId: integrationEnv.accessKeyId,
      secretAccessKey: integrationEnv.secretAccessKey,
    });
    expect(
      await client.receiveMessages({ queueUrl: eventsQueueUrl }),
    ).toEqual([]);

    // Instância NOVA assume o trabalho pendente e drena a outbox — é o que o
    // serviço reiniciado faz pelo worker de publicação (§11: "outra instância
    // assume o trabalho; o evento é publicado").
    const second = await runProcesses([
      { operation: 'publish-outbox', payload: { queueUrl: eventsQueueUrl } },
    ]);
    expect(second[0]).toMatchObject({
      claimed: pending.length,
      published: pending.length,
      failed: 0,
    });

    const after = await readRows(`select status from outbox_messages`);
    for (const row of after) {
      expect(row['status']).toBe('PUBLISHED');
    }

    // Os eventos confirmados chegaram ao SQS real.
    const received = await client.receiveMessages({ queueUrl: eventsQueueUrl });
    expect(received).toHaveLength(pending.length);

    // Estado final consistente depois da queda e da retomada (§13).
    await expectWalletReconciled(wallet.id);

    // O processamento continua correto na instância seguinte.
    const third = await runProcesses([
      { operation: 'bet', payload: betPayload(wallet.id, playerId, '20.00') },
    ]);
    expect(third[0]!['status']).toBe('PROCESSED');
    await expectWalletReconciled(wallet.id);
  }, 60_000);
});
