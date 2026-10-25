import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/application/wallets/use-cases/open-wallet.use-case.js';
import {
  ProcessBetInput,
  ProcessBetUseCase,
} from '../../src/application/wagering/use-cases/process-bet.use-case.js';
import {
  ProcessLossUseCase,
} from '../../src/application/wagering/use-cases/process-loss.use-case.js';
import {
  ProcessReversalInput,
  ProcessReversalUseCase,
} from '../../src/application/wagering/use-cases/process-reversal.use-case.js';
import {
  ProcessWinInput,
  ProcessWinUseCase,
} from '../../src/application/wagering/use-cases/process-win.use-case.js';
import {
  ResolvePendingReferencesUseCase,
} from '../../src/application/wagering/use-cases/resolve-pending-references.use-case.js';
import { Money } from '../../src/domain/shared/value-objects/money.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';
import {
  bootstrapIntegrationOrm,
  disposeIntegrationOrm,
  truncateIntegrationTables,
} from './support/orm.js';

/**
 * `LOSS`, `REFUND` e `ROLLBACK` (README §7) em PostgreSQL real.
 *
 * Regras cobertas: 1 (referência obrigatória), 3 (kinds aceitos), 4 (a mesma
 * referência não é revertida duas vezes pelo mesmo tipo), 5 (valor igual), 6
 * (rejeição não move saldo), 9 (reversão que negativaria tem failureCode
 * distinto) e o efeito de `LOSS` (nenhum).
 */

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

function em(): EntityManager {
  return orm.em.fork();
}

async function openWallet(
  playerId: string,
  amount: string,
): Promise<{ id: string }> {
  return new OpenWalletUseCase(em()).execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
  });
}

function bet(walletId: string, playerId: string, amount: string, external: string) {
  return new ProcessBetUseCase(em()).execute({
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: external,
    idempotencyKey: `key-${external}`,
    amount,
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
  } as ProcessBetInput);
}

function win(walletId: string, playerId: string, amount: string, external: string, reference?: string) {
  return new ProcessWinUseCase(em()).execute({
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: external,
    idempotencyKey: `key-${external}`,
    amount,
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  } as ProcessWinInput);
}

function reversal(
  kind: WagerTransactionKind.REFUND | WagerTransactionKind.ROLLBACK,
  walletId: string,
  playerId: string,
  amount: string,
  reference: string,
  external = `rev-${randomUUID()}`,
) {
  return new ProcessReversalUseCase(em()).execute({
    kind,
    walletId,
    playerId,
    providerId: 'provider-a',
    externalTransactionId: external,
    idempotencyKey: `key-${external}`,
    amount,
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    referenceExternalTransactionId: reference,
  } as ProcessReversalInput);
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await orm.em.getConnection().execute(
    `select balance from wallets where id = '${walletId}'`,
  )) as Array<{ balance: string }>;

  return rows[0]!.balance;
}

describe('LOSS (§7) — sem efeito de saldo', () => {
  it('registra o resultado sem mover saldo nem ledger', async () => {
    const playerId = `it-loss-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const result = await new ProcessLossUseCase(em()).execute({
      walletId: wallet.id,
      playerId,
      providerId: 'provider-a',
      externalTransactionId: `loss-${randomUUID()}`,
      idempotencyKey: `key-${randomUUID()}`,
      amount: '25.00',
      currency: 'BRL',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
    });

    expect(result.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const ledger = await orm.em.getConnection().execute(
      `select * from wallet_ledger_entries where wallet_id = '${wallet.id}'`,
    );
    expect(ledger).toHaveLength(1); // só a abertura

    const events = await orm.em.getConnection().execute(
      `select event_type from outbox_messages`,
    );
    expect(events.map((row) => (row as { event_type: string }).event_type)).toContain(
      'WagerTransactionProcessed',
    );
  });
});

describe('REFUND (§7) — reverte uma BET aplicada, uma única vez', () => {
  it('credita o valor da BET e uma segunda REFUND é rejeitada', async () => {
    const playerId = `it-refund-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await bet(wallet.id, playerId, '30.00', `bet-${randomUUID()}`);

    const bets = (await orm.em.getConnection().execute(
      `select id, external_transaction_id from wager_transactions where kind = 'BET'`,
    )) as Array<{ id: string; external_transaction_id: string }>;
    const betExternal = bets[0]!.external_transaction_id;

    const refunded = await reversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '30.00',
      betExternal,
    );

    expect(refunded.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');

    // Regra 4: a mesma referência não é revertida duas vezes pelo mesmo tipo.
    // Com o índice cobrindo apenas `PROCESSED`, a tentativa recusada é
    // registrada como `REJECTED` (auditável) sem mover saldo.
    const again = await reversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '30.00',
      betExternal,
    );

    expect(again.status).toBe('REJECTED');
    expect(again.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('regra 5: valor diferente do da referência é rejeitado', async () => {
    const playerId = `it-refund-amount-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await bet(wallet.id, playerId, '30.00', `bet-${randomUUID()}`);

    const betExternal = (
      (await orm.em.getConnection().execute(
        `select external_transaction_id from wager_transactions where kind = 'BET'`,
      )) as Array<{ external_transaction_id: string }>
    )[0]!.external_transaction_id;

    const result = await reversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '25.00',
      betExternal,
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FailureCode.REFERENCE_AMOUNT_MISMATCH);
    expect(await balanceOf(wallet.id)).toBe('70.00');
  });

  it('referência ausente vira PENDING_REFERENCE (regra 8)', async () => {
    const playerId = `it-refund-missing-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const result = await reversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '30.00',
      `bet-${randomUUID()}`,
    );

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('ROLLBACK (§7) — inverte a referência', () => {
  it('ROLLBACK de um WIN debita e o de uma BET credita', async () => {
    const playerId = `it-rollback-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const betExternal = `bet-${randomUUID()}`;
    await bet(wallet.id, playerId, '10.00', betExternal);
    await win(wallet.id, playerId, '25.00', `win-${randomUUID()}`, betExternal);

    expect(await balanceOf(wallet.id)).toBe('115.00');

    // Regra 3: ROLLBACK reverte a WIN (crédito) → debita o mesmo valor.
    const wins = (await orm.em.getConnection().execute(
      `select external_transaction_id from wager_transactions where kind = 'WIN'`,
    )) as Array<{ external_transaction_id: string }>;

    const rolled = await reversal(
      WagerTransactionKind.ROLLBACK,
      wallet.id,
      playerId,
      '25.00',
      wins[0]!.external_transaction_id,
    );

    expect(rolled.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('90.00');

    // Regra 9: a próxima reversão de BET (crédito) segue normal…
    const rollbackBet = await reversal(
      WagerTransactionKind.ROLLBACK,
      wallet.id,
      playerId,
      '10.00',
      betExternal,
    );

    expect(rollbackBet.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('regra 9: reversão que negativaria o saldo tem failureCode distinto', async () => {
    const playerId = `it-rollback-negative-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const betExternal = `bet-${randomUUID()}`;
    await bet(wallet.id, playerId, '10.00', betExternal);
    await win(wallet.id, playerId, '25.00', `win-${randomUUID()}`, betExternal);
    await bet(wallet.id, playerId, '100.00', `bet-${randomUUID()}`);

    // 100 - 10 + 25 - 100 = 15.00
    expect(await balanceOf(wallet.id)).toBe('15.00');

    const wins = (await orm.em.getConnection().execute(
      `select external_transaction_id from wager_transactions where kind = 'WIN'`,
    )) as Array<{ external_transaction_id: string }>;

    // ROLLBACK da WIN debita 25.00 sobre 15.00 → saldo negativo (regra 9),
    // com failureCode DISTINTO do de aposta sem saldo.
    const blocked = await reversal(
      WagerTransactionKind.ROLLBACK,
      wallet.id,
      playerId,
      '25.00',
      wins[0]!.external_transaction_id,
    );

    expect(blocked.status).toBe('REJECTED');
    expect(blocked.failureCode).toBe(
      FailureCode.INSUFFICIENT_BALANCE_FOR_REVERSAL,
    );
    expect(blocked.failureCode).not.toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(await balanceOf(wallet.id)).toBe('15.00');
  });
});

describe('Reversões pendentes (§7.1) aplicam as regras 3/4/5/9', () => {
  function pendingReversal(
    kind: WagerTransactionKind.REFUND | WagerTransactionKind.ROLLBACK,
    walletId: string,
    playerId: string,
    amount: string,
    reference: string,
  ) {
    return new ProcessReversalUseCase(em()).execute({
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
    } as ProcessReversalInput);
  }

  function runWorker() {
    return new ResolvePendingReferencesUseCase(em()).execute({
      now: new Date(),
    });
  }

  it('1) ROLLBACK de WIN pendente é resolvida como DÉBITO', async () => {
    const playerId = `it-pending-rollback-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const pending = await pendingReversal(
      WagerTransactionKind.ROLLBACK,
      wallet.id,
      playerId,
      '25.00',
      'win-late-1',
    );
    expect(pending.status).toBe('PENDING_REFERENCE');

    // A referência chega depois: uma WIN de 25.00.
    await win(wallet.id, playerId, '25.00', 'win-late-1');
    expect(await balanceOf(wallet.id)).toBe('125.00');

    const cycle = await runWorker();
    expect(cycle.resolved).toBe(1);

    // A ROLLBACK de uma WIN DEVE debitar — não creditar.
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('2) REFUND pendente com valor divergente é rejeitado sem mexer no saldo', async () => {
    const playerId = `it-pending-refund-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const pending = await pendingReversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '25.00',
      'bet-late-2',
    );
    expect(pending.status).toBe('PENDING_REFERENCE');

    await bet(wallet.id, playerId, '30.00', 'bet-late-2');
    expect(await balanceOf(wallet.id)).toBe('70.00');

    const cycle = await runWorker();
    expect(cycle.rejected).toBe(1);

    const rows = (await orm.em.getConnection().execute(
      `select status, rejection_reason from wager_transactions where kind = 'REFUND'`,
    )) as Array<{ status: string; rejection_reason: string }>;
    expect(rows[0]).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'REFERENCE_AMOUNT_MISMATCH',
    });
    expect(await balanceOf(wallet.id)).toBe('70.00');
  });

  it('3) ROLLBACK pendente que negativaria o saldo é rejeitado', async () => {
    const playerId = `it-pending-negative-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    const pending = await pendingReversal(
      WagerTransactionKind.ROLLBACK,
      wallet.id,
      playerId,
      '80.00',
      'win-late-3',
    );
    expect(pending.status).toBe('PENDING_REFERENCE');

    await win(wallet.id, playerId, '80.00', 'win-late-3');
    await bet(wallet.id, playerId, '70.00', `bet-${randomUUID()}`);
    // 100 + 80 - 70 = 110; debitar 80 deixaria 30 — ok; vamos consumir mais.
    await bet(wallet.id, playerId, '100.00', `bet-${randomUUID()}`);
    expect(await balanceOf(wallet.id)).toBe('10.00');

    const cycle = await runWorker();
    expect(cycle.rejected).toBe(1);

    const rows = (await orm.em.getConnection().execute(
      `select status, rejection_reason from wager_transactions where kind = 'ROLLBACK'`,
    )) as Array<{ status: string; rejection_reason: string }>;
    expect(rows[0]).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'INSUFFICIENT_BALANCE_FOR_REVERSAL',
    });
    expect(await balanceOf(wallet.id)).toBe('10.00');
  });

  it('4) reversão rejeitada não bloqueia a tentativa corrigida', async () => {
    const playerId = `it-retry-reversal-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await bet(wallet.id, playerId, '30.00', 'bet-fixed');

    const wrong = await reversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '25.00',
      'bet-fixed',
    );
    expect(wrong.status).toBe('REJECTED');
    expect(wrong.failureCode).toBe(FailureCode.REFERENCE_AMOUNT_MISMATCH);

    // O provedor corrige o valor e reenvia: a tentativa corrigida PASSA.
    const corrected = await reversal(
      WagerTransactionKind.REFUND,
      wallet.id,
      playerId,
      '30.00',
      'bet-fixed',
    );

    expect(corrected.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('5) duas reversões concorrentes da mesma referência: no máximo uma', async () => {
    const playerId = `it-concurrent-reversal-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');
    await bet(wallet.id, playerId, '30.00', 'bet-concurrent');

    const attempts = await Promise.allSettled([
      reversal(WagerTransactionKind.REFUND, wallet.id, playerId, '30.00', 'bet-concurrent'),
      reversal(WagerTransactionKind.REFUND, wallet.id, playerId, '30.00', 'bet-concurrent'),
    ]);

    const processed = attempts.filter(
      (attempt) =>
        attempt.status === 'fulfilled' && attempt.value.status === 'PROCESSED',
    );

    expect(processed).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('6) reexecutar o worker não duplica o efeito financeiro', async () => {
    const playerId = `it-worker-rerun-${randomUUID()}`;
    const wallet = await openWallet(playerId, '100.00');

    await pendingReversal(
      WagerTransactionKind.ROLLBACK,
      wallet.id,
      playerId,
      '25.00',
      'win-late-6',
    );
    await win(wallet.id, playerId, '25.00', 'win-late-6');

    const first = await runWorker();
    expect(first.resolved).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    // Redelivery/reexecução: a linha já é terminal, nada se aplica de novo.
    const second = await runWorker();
    expect(second.claimed).toBe(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const ledger = await orm.em.getConnection().execute(
      `select * from wallet_ledger_entries where wallet_id = '${wallet.id}'`,
    );
    expect(ledger).toHaveLength(3); // abertura + WIN + ROLLBACK
  });
});
