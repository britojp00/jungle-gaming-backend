import { UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { describe, expect, it } from 'vitest';

import { FakeEntityManager } from '../../../../test/support/fake-entity-manager.js';
import { InboxMessageStatus } from '../../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../../../infrastructure/persistence/entities/inbox-message.entity.js';
import { WalletEntity } from '../../../infrastructure/persistence/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionStatus,
} from '../../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import {
  parseWagerTransactionRequested,
  WagerTransactionRequested,
} from '../wager-transaction-requested.js';
import {
  ReceiveWagerTransactionUseCase,
  WAGER_COMMAND_CONSUMER_NAME,
} from './receive-wager-transaction.use-case.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-24T12:00:00.000Z');

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

function command(
  overrides: Record<string, unknown> = {},
): WagerTransactionRequested {
  return parseWagerTransactionRequested({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-24T11:59:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: 'player-1',
      walletId: WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
    ...overrides,
  });
}

function inboxRow(fake: FakeEntityManager) {
  const rows = fake.rows<Record<string, unknown>>(InboxMessageEntity);

  expect(rows).toHaveLength(1);

  return rows[0]!;
}

describe('ReceiveWagerTransactionUseCase — Inbox + efeitos (§10 e §11)', () => {
  it('registra a Inbox e aplica a BET na mesma transação', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));

    const result = await new ReceiveWagerTransactionUseCase(
      fake.asEntityManager(),
    ).execute(command(), { now: NOW });

    expect(result).toMatchObject({
      outcome: 'processed',
      status: WagerTransactionStatus.PROCESSED,
    });

    // Inbox confirmada junto dos efeitos.
    const inbox = inboxRow(fake);
    expect(inbox['consumerName']).toBe(WAGER_COMMAND_CONSUMER_NAME);
    expect(inbox['messageId']).toBe('msg-123');
    expect(inbox['eventType']).toBe('WagerTransactionRequested');
    expect(inbox['status']).toBe(InboxMessageStatus.PROCESSED);
    expect(inbox['processedAt']).toEqual(NOW);
    expect(String(inbox['payloadHash'])).toHaveLength(64);

    // Efeitos financeiros aplicados pelo MESMO caso de uso da entrada.
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!['balance']).toBe('75.00');
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);

    const transaction = fake.rows<Record<string, unknown>>(
      WagerTransactionEntity,
    )[0]!;
    expect(transaction['kind']).toBe('BET');
    expect(transaction['status']).toBe(WagerTransactionStatus.PROCESSED);
  });

  it('entrega repetida de mensagem já confirmada não gera efeito novo', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));

    const useCase = new ReceiveWagerTransactionUseCase(fake.asEntityManager());

    await useCase.execute(command(), { now: NOW });
    const again = await useCase.execute(command(), {
      now: new Date('2026-10-24T12:00:30.000Z'),
    });

    // A garantia é persistente (§5.2): a chave (consumerName, messageId) já
    // está confirmada, então não há o que repetir.
    expect(again).toEqual({ outcome: 'duplicate' });
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(1);
    expect(fake.rows(WagerTransactionEntity)).toHaveLength(1);
    expect(fake.rows<WalletEntity>(WalletEntity)[0]!['balance']).toBe('75.00');
    expect(inboxRow(fake)['processedAt']).toEqual(NOW);
  });

  it('falha do caso de uso é propagada — nada é confirmado pela metade', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));

    // O 1º flush é o da Inbox; o 2º é o dos efeitos.
    let flushes = 0;
    fake.beforeFlush = () => {
      flushes += 1;

      if (flushes === 2) {
        throw new Error('SIMULATED_FAILURE_AFTER_INBOX');
      }
    };

    // O erro sobe: quem chama decide (DLQ ou reentrega) e **não** confirma.
    // O desfazer junto da Inbox é garantia do PostgreSQL, não deste fake —
    // é comprovado em `test/integration/wager-command-consumer...`.
    await expect(
      new ReceiveWagerTransactionUseCase(fake.asEntityManager()).execute(
        command(),
        { now: NOW },
      ),
    ).rejects.toThrow('SIMULATED_FAILURE_AFTER_INBOX');

    // Nada aqui alega rollback: desfazer junto da Inbox é garantia do
    // PostgreSQL, comprovada na integração com banco real.
  });

  it('WIN com referência segue para o caso de uso de WIN', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));

    const result = await new ReceiveWagerTransactionUseCase(
      fake.asEntityManager(),
    ).execute(
      command({
        data: {
          providerId: 'provider-a',
          externalTransactionId: 'win-1',
          idempotencyKey: 'provider-a:win-1',
          playerId: 'player-1',
          walletId: WALLET_ID,
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'WIN',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: 'bet-ausente',
        },
      }),
      { now: NOW },
    );

    // Referência ausente (§7, regra 8) vira PENDING_REFERENCE — o consumidor
    // repassa a política inteira ao caso de uso, sem reinterpretar.
    expect(result).toMatchObject({
      outcome: 'processed',
      status: WagerTransactionStatus.PENDING_REFERENCE,
    });
    expect(inboxRow(fake)['status']).toBe(InboxMessageStatus.PROCESSED);
    expect(fake.rows(WalletLedgerEntryEntity)).toHaveLength(0);
  });

  it('propaga a violação da única da Inbox quando outra entrega já registrou', async () => {
    const fake = new FakeEntityManager();
    fake.seed(WalletEntity, seededWalletRow('100.00'));

    // Mesma chave lógica, outro id, ainda não processada: só o banco pode
    // recusar — e a recusa é o que o consumidor interpreta como "já em
    // andamento por outra instância".
    fake.seed(InboxMessageEntity, {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      consumerName: WAGER_COMMAND_CONSUMER_NAME,
      messageId: 'msg-123',
      eventType: 'WagerTransactionRequested',
      payloadHash: 'a'.repeat(64),
      payload: {},
      status: InboxMessageStatus.RECEIVED,
      attempts: 0,
      nextAttemptAt: NOW,
      lastError: null,
      receivedAt: NOW,
      processedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(
      new ReceiveWagerTransactionUseCase(fake.asEntityManager()).execute(
        command(),
        { now: NOW },
      ),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });
});
