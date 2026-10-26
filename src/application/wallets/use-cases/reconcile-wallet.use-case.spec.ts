import { beforeEach, describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import { metrics } from '../../../infrastructure/observability/metrics.js';
import {
  LedgerDirection,
  WalletLedgerEntryEntity,
} from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const OPENING_TX_ID = '22222222-2222-4222-8222-222222222222';
const BET_TX_ID = '33333333-3333-4333-8333-333333333333';

function seededWalletRow(balance: string) {
  return {
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    updatedAt: new Date('2026-10-25T10:00:00.000Z'),
  };
}

function ledgerRow(overrides: Record<string, unknown>) {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    wallet: { __reference: true, entityClass: WalletEntity, id: WALLET_ID },
    transaction: {
      __reference: true,
      entityClass: WagerTransactionEntity,
      id: OPENING_TX_ID,
    },
    direction: LedgerDirection.CREDIT,
    amount: '100.00',
    balanceBefore: '0.00',
    balanceAfter: '100.00',
    currency: 'BRL',
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    ...overrides,
  };
}

/** Lançamento `DEBIT` de 30.00 — o caso de uso só lê direção, valor e moeda. */
function debitLedgerRow() {
  return ledgerRow({
    id: BET_TX_ID,
    direction: LedgerDirection.DEBIT,
    amount: '30.00',
    balanceBefore: '100.00',
    balanceAfter: '70.00',
  });
}

function divergences(): number {
  const counters = metrics.snapshot()['counters'] as Record<string, number>;

  return counters['reconciliation_divergences_total'] ?? 0;
}

describe('ReconcileWalletUseCase — reconciliação saldo ⇄ ledger (README §9)', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('consistente: devolve diferença zero e NÃO conta divergência', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WalletLedgerEntryEntity, ledgerRow({}));

    const result = await new ReconcileWalletUseCase(
      fake.asEntityManager(),
    ).execute(WALLET_ID);

    // Comportamento financeiro inalterado: saldos e contagem na resposta.
    expect(result).toEqual({
      walletId: WALLET_ID,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
    expect(divergences()).toBe(0);
  });

  it('divergente: acusa a diferença, não corrige nada e conta a métrica', async () => {
    const fake = new FakeEntityManager();
    // Saldo materializado corrompido (100.00) contra o ledger real (70.00).
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WalletLedgerEntryEntity, ledgerRow({}));
    fake.seed(WalletLedgerEntryEntity, debitLedgerRow());

    const result = await new ReconcileWalletUseCase(
      fake.asEntityManager(),
    ).execute(WALLET_ID);

    expect(result).toEqual({
      walletId: WALLET_ID,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '30.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });

    // §9: divergência contabilizada em métrica — uma consulta divergente,
    // uma contagem. Nada foi corrigido: o saldo segue como estava.
    expect(divergences()).toBe(1);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!.balance).toBe('100.00');
  });

  it('segunda consulta divergente acumula a contagem', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));
    fake.seed(WalletLedgerEntryEntity, ledgerRow({}));
    fake.seed(WalletLedgerEntryEntity, debitLedgerRow());

    const useCase = new ReconcileWalletUseCase(fake.asEntityManager());
    await useCase.execute(WALLET_ID);
    await useCase.execute(WALLET_ID);

    expect(divergences()).toBe(2);
  });

  it('wallet inexistente falha sem tocar na métrica', async () => {
    const fake = new FakeEntityManager();

    await expect(
      new ReconcileWalletUseCase(fake.asEntityManager()).execute(WALLET_ID),
    ).rejects.toThrow('WALLET_NOT_FOUND');

    expect(divergences()).toBe(0);
  });
});
