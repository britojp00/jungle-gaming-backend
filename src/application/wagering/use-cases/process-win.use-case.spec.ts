import { describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import {
  LedgerDirection,
  WalletLedgerEntryEntity,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../../infrastructure/persistence/entities/outbox-message.entity.js';
import {
  ProcessWinInput,
  ProcessWinUseCase,
} from './process-win.use-case.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WALLET_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

function seededWalletRow(balance: string) {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    updatedAt: new Date('2026-10-24T10:00:00.000Z'),
  };
}

function referenceTo(walletId: string) {
  return { __reference: true, entityClass: WalletEntity, id: walletId };
}

/**
 * Transação referenciável já persistida (uma BET `PROCESSED` da mesma
 * rodada) — o caso de uso só consulta colunas/filtro de PK, então o que
 * importa aqui são os vínculos da regra 2: provider, player, wallet, moeda
 * e rodada.
 */
function seededReferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    wallet: referenceTo(WALLET_ID),
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'bet-777',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.BET,
    status: WagerTransactionStatus.PROCESSED,
    amount: '10.00',
    currency: 'BRL',
    ...overrides,
  };
}

function winInput(
  overrides: Partial<ProcessWinInput> = {},
): ProcessWinInput {
  return {
    walletId: WALLET_ID,
    playerId: 'player-1',
    providerId: 'provider-a',
    externalTransactionId: 'win-100',
    idempotencyKey: 'provider-a:win-100',
    amount: '25.00',
    currency: 'BRL',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    ...overrides,
  };
}

function eventTypes(fake: FakeEntityManager): string[] {
  return fake
    .rows<OutboxMessageEntity>(OutboxMessageEntity)
    .map((event) => event.eventType);
}

function findEvent(fake: FakeEntityManager, eventType: string) {
  return fake
    .rows<OutboxMessageEntity>(OutboxMessageEntity)
    .find((event) => event.eventType === eventType);
}

describe('ProcessWinUseCase — WIN sem referência (crédito imediato)', () => {
  it('credita, gera um CREDIT, persiste PROCESSED e emite os eventos da §11', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    const result = await useCase.execute(winInput());

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(2);
    expect(result.replayed).toBe(false);
    expect(result.failureCode).toBeUndefined();

    const rows = fake.rows<WagerTransactionEntity>(WagerTransactionEntity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(WagerTransactionKind.WIN);
    expect(rows[0]!.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(rows[0]!.referenceExternalTransactionId).toBeNull();
    expect(rows[0]!.referenceTransaction).toBeNull();
    expect(rows[0]!.processedAt).toBeInstanceOf(Date);
    expect(rows[0]!.rejectionReason).toBeNull();
    expect(rows[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.resultBalanceAmount).toBe('125.00');

    // Exatamente um lançamento, na direção CREDIT (README §7, tabela).
    const entries = fake.rows<WalletLedgerEntryEntity>(WalletLedgerEntryEntity);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.CREDIT);
    expect(entries[0]!.amount).toBe('25.00');
    expect(entries[0]!.balanceBefore).toBe('100.00');
    expect(entries[0]!.balanceAfter).toBe('125.00');

    // Dois eventos, um por transação aplicada e um porque o saldo mudou.
    expect(eventTypes(fake)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    // Contrato §11 de WalletBalanceChangedData, sem campos extras.
    const balanceChanged = findEvent(fake, 'WalletBalanceChanged')!;
    expect(balanceChanged.aggregateId).toBe(WALLET_ID);
    expect(balanceChanged.payload.data).toEqual({
      walletId: WALLET_ID,
      transactionId: result.transactionId,
      direction: LedgerDirection.CREDIT,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '125.00', currency: 'BRL' },
      walletVersion: 2,
    });

    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('125.00');
  });

  it('valida referência em branco e valor não positivo antes de tocar o banco', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    await expect(
      useCase.execute(winInput({ referenceExternalTransactionId: '   ' })),
    ).rejects.toThrow('INVALID_REFERENCEEXTERNALTRANSACTIONID');
    await expect(
      useCase.execute(winInput({ amount: '0.00' })),
    ).rejects.toThrow('WIN amount must be positive');
    await expect(
      useCase.execute(winInput({ roundId: '' })),
    ).rejects.toThrow('INVALID_ROUNDID');

    // Payload inválido não alcança a wallet: nenhuma linha em transação,
    // ledger ou outbox.
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(0);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows(OutboxMessageEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.version).toBe(1);
  });
});

describe('ProcessWinUseCase — referência inexistente (regra 8)', () => {
  it('persiste PENDING_REFERENCE com o evento aprovado, sem saldo nem ledger', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    const result = await useCase.execute(
      winInput({ referenceExternalTransactionId: 'bet-777' }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(result.replayed).toBe(false);
    // Nada foi aplicado: o saldo observado é o da abertura.
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(1);

    const row = fake.rows<WagerTransactionEntity>(WagerTransactionEntity)[0]!;
    expect(row.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(row.referenceExternalTransactionId).toBe('bet-777');
    // Sem alvo não há FK interna (o schema aceita `reference_transaction_id`
    // nulo em qualquer kind — verificado em ARCHITECTURE.md).
    expect(row.referenceTransaction).toBeNull();
    expect(row.processedAt).toBeNull();
    expect(row.rejectionReason).toBeNull();
    expect(row.resultBalanceAmount).toBe('100.00');

    // Regra 8: sem saldo e sem lançamento.
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.version).toBe(1);

    // Um único evento, e NÃO é WalletBalanceChanged (§11: "somente quando o
    // saldo muda").
    expect(eventTypes(fake)).toEqual(['WagerTransactionPendingReference']);

    // Payload "Opção A" aprovado — envelope da §11 + data sem saldo/versão.
    const pending = findEvent(fake, 'WagerTransactionPendingReference')!;
    expect(pending.id).toBeDefined();
    expect(pending.aggregateId).toBe(result.transactionId);
    expect(pending.status).toBe('PENDING');
    expect(pending.payload.eventType).toBe(
      'WagerTransactionPendingReference',
    );
    expect(pending.payload.version).toBe(1);
    expect(pending.payload.correlationId).toBe(result.transactionId);
    expect(typeof pending.payload.occurredAt).toBe('string');
    expect(pending.payload.data).toEqual({
      transactionId: result.transactionId,
      playerId: 'player-1',
      walletId: WALLET_ID,
      kind: WagerTransactionKind.WIN,
      status: WagerTransactionStatus.PENDING_REFERENCE,
      amount: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-777',
    });
    expect(pending.payload.data).not.toHaveProperty('balance');
    expect(pending.payload.data).not.toHaveProperty('walletVersion');
  });

  it('replay de WIN ainda pendente devolve o resultado original sem resolver', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    const input = winInput({ referenceExternalTransactionId: 'bet-777' });
    const first = await useCase.execute(input);

    // A referência "chega" depois — em produção seria outra transação; aqui
    // a linha passa a existir no banco.
    fake.seed(WagerTransactionEntity, seededReferenceRow());

    const second = await useCase.execute(input);

    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(second.balance).toEqual(first.balance);
    expect(second.walletVersion).toBe(first.walletVersion);

    // O replay NÃO resolve: quem resolve é o worker de §7.1, não a reentrada.
    const wins = fake
      .rows<WagerTransactionEntity>(WagerTransactionEntity)
      .filter((row) => row.kind === WagerTransactionKind.WIN);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(wins[0]!.referenceTransaction).toBeNull();

    // Nenhum efeito novo: sem crédito, sem lançamento, sem evento extra.
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
    expect(eventTypes(fake)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('ProcessWinUseCase — referência compatível (regra 2)', () => {
  it('resolve a referência, credita e grava a FK interna da BET', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WagerTransactionEntity, seededReferenceRow());
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    const result = await useCase.execute(
      winInput({ referenceExternalTransactionId: 'bet-777' }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(2);

    const row = fake.rows<WagerTransactionEntity>(WagerTransactionEntity).find(
      (candidate) => candidate.kind === WagerTransactionKind.WIN,
    )!;
    expect(row.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(row.referenceExternalTransactionId).toBe('bet-777');
    // A FK interna aponta para a transação resolvida (id interno, não o id
    // externo do provedor — README 6.3).
    expect(row.referenceTransaction).toEqual(
      expect.objectContaining({ id: TARGET_ID }),
    );
    expect(row.processedAt).toBeInstanceOf(Date);

    const entries = fake.rows<WalletLedgerEntryEntity>(WalletLedgerEntryEntity);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.CREDIT);
    expect(entries[0]!.amount).toBe('25.00');

    // Sem evento pendente: a referência existia.
    expect(eventTypes(fake)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(findEvent(fake, 'WagerTransactionPendingReference')).toBeUndefined();
  });
});

describe('ProcessWinUseCase — elegibilidade da referência (política do ARCHITECTURE.md)', () => {
  // Regra 2 do §7 resolve a referência por chave + identidade (provider,
  // player, wallet, moeda, rodada) e **não** impõe condição de status ou de
  // kind ao alvo — exigência de `BET` `PROCESSED` existe apenas para
  // `REFUND`/`ROLLBACK` (tabela §7 + regra 3). A tabela §7 define o efeito
  // da `WIN` como crédito, e a referência é **opcional** ("pode referenciar
  // a `BET` da mesma rodada"). Portanto o crédito **não** depende do estado
  // do alvo: o que se rejeita é identidade divergente (casos acima), não
  // resultado. Decisão deliberada registrada em `ARCHITECTURE.md`
  // ("Decisão — política de referência do `WIN`", item 3).
  const eligibilityCases: Array<{
    label: string;
    target: Record<string, unknown>;
  }> = [
    {
      label: 'BET REJECTED',
      target: {
        kind: WagerTransactionKind.BET,
        status: WagerTransactionStatus.REJECTED,
      },
    },
    {
      label: 'LOSS',
      target: {
        kind: WagerTransactionKind.LOSS,
        status: WagerTransactionStatus.PROCESSED,
      },
    },
    {
      label: 'REFUND',
      target: {
        kind: WagerTransactionKind.REFUND,
        status: WagerTransactionStatus.PROCESSED,
      },
    },
    {
      label: 'alvo ainda PENDING_REFERENCE',
      target: {
        kind: WagerTransactionKind.BET,
        status: WagerTransactionStatus.PENDING_REFERENCE,
      },
    },
  ];

  for (const eligibilityCase of eligibilityCases) {
    it(`credita quando a referência é ${eligibilityCase.label} (identidade da regra 2 satisfeita)`, async () => {
      const fake = new FakeEntityManager();
      fake.seed(WalletEntity, seededWalletRow('100.00'));
      fake.seed(
        WagerTransactionEntity,
        seededReferenceRow(eligibilityCase.target),
      );
      const useCase = new ProcessWinUseCase(fake.asEntityManager());

      const result = await useCase.execute(
        winInput({ referenceExternalTransactionId: 'bet-777' }),
      );

      expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });
      expect(result.failureCode).toBeUndefined();

      const row = fake
        .rows<WagerTransactionEntity>(WagerTransactionEntity)
        .find((candidate) => candidate.kind === WagerTransactionKind.WIN)!;
      expect(row.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(row.referenceTransaction).toEqual(
        expect.objectContaining({ id: TARGET_ID }),
      );

      const entries = fake.rows<WalletLedgerEntryEntity>(WalletLedgerEntryEntity);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.direction).toBe(LedgerDirection.CREDIT);
    });
  }
});

describe('ProcessWinUseCase — divergência em cada vínculo da regra 2', () => {
  const mismatchCases: Array<{
    label: string;
    target: Record<string, unknown>;
  }> = [
    { label: 'outro provider', target: { providerId: 'provider-b' } },
    { label: 'outro player', target: { playerId: 'player-2' } },
    { label: 'outra wallet', target: { wallet: referenceTo(OTHER_WALLET_ID) } },
    { label: 'outra moeda', target: { currency: 'USD' } },
    { label: 'outra rodada', target: { roundId: 'round-000' } },
  ];

  for (const mismatchCase of mismatchCases) {
    it(`rejeita com REFERENCE_MISMATCH quando a referência é de ${mismatchCase.label}`, async () => {
      const fake = new FakeEntityManager();
      fake.seed(WalletEntity, seededWalletRow('100.00'));
      fake.seed(
        WagerTransactionEntity,
        seededReferenceRow(mismatchCase.target),
      );
      const useCase = new ProcessWinUseCase(fake.asEntityManager());

      const result = await useCase.execute(
        winInput({ referenceExternalTransactionId: 'bet-777' }),
      );

      expect(result.status).toBe(WagerTransactionStatus.REJECTED);
      expect(result.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
      expect(result.failureCode).toBe('REFERENCE_MISMATCH');

      // Regra 6: REJECTED não move saldo nem gera lançamento.
      expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
      expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
      expect(fake.rows<WalletEntity>(WalletEntity)[0]!.version).toBe(1);

      const row = fake.rows<WagerTransactionEntity>(WagerTransactionEntity).find(
        (candidate) => candidate.kind === WagerTransactionKind.WIN,
      )!;
      expect(row.status).toBe(WagerTransactionStatus.REJECTED);
      expect(row.rejectionReason).toBe('REFERENCE_MISMATCH');
      expect(row.referenceTransaction).toBeNull();
      expect(row.processedAt).toBeNull();

      expect(eventTypes(fake)).toEqual(['WagerTransactionRejected']);

      const rejected = findEvent(fake, 'WagerTransactionRejected')!;
      expect(rejected.payload.data).toEqual(
        expect.objectContaining({
          transactionId: result.transactionId,
          walletId: WALLET_ID,
          kind: WagerTransactionKind.WIN,
          status: WagerTransactionStatus.REJECTED,
          amount: { amount: '25.00', currency: 'BRL' },
          failureCode: FailureCode.REFERENCE_MISMATCH,
        }),
      );
    });
  }
});

describe('ProcessWinUseCase — idempotência', () => {
  it('replay de WIN processada devolve o resultado original sem novos efeitos', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    const input = winInput();
    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(first.status);
    expect(second.balance).toEqual(first.balance);
    expect(second.walletVersion).toBe(first.walletVersion);

    // Um único crédito, um único lançamento, eventos não duplicados.
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(1);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);
    expect(eventTypes(fake)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('125.00');
  });

  it('mesma chave com payload diferente gera conflito, não replay (README §9)', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    const useCase = new ProcessWinUseCase(fake.asEntityManager());

    await useCase.execute(winInput());

    // Mesma `(providerId, idempotencyKey)`, conteúdo diferente.
    await expect(
      useCase.execute(winInput({ amount: '30.00' })),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');

    // A WIN com referência usa OUTRA chave, mas a de referência divergente
    // na MESMA chave também conflita: `kind` e referência entram no hash.
    await expect(
      useCase.execute(
        winInput({ referenceExternalTransactionId: 'bet-777' }),
      ),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');

    expect(fake.rows(WagerTransactionEntity)).toHaveLength(1);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('125.00');
  });
});
