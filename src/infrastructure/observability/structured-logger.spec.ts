import { afterEach, describe, expect, it, vi } from 'vitest';

import { logEvent } from './structured-logger.js';

/**
 * Contrato mínimo do §12: uma linha JSON por evento, com os identificadores
 * de contexto e sem valores indefinidos nem payload financeiro.
 */
describe('logEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emite UMA linha JSON com nível, evento e campos de contexto', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logEvent('log', 'transaction_submitted', {
      correlationId: 'tx-1',
      messageId: 'provider-a:tx-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]![0])) as Record<
      string,
      unknown
    >;

    expect(line).toMatchObject({
      level: 'log',
      event: 'transaction_submitted',
      correlationId: 'tx-1',
      messageId: 'provider-a:tx-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
    });
    expect(String(line['ts'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('descarta campos indefinidos e roteia o nível pelo console certo', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logEvent('error', 'command_dead_lettered', {
      messageId: 'msg-1',
      transactionId: undefined,
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    const line = JSON.parse(String(error.mock.calls[0]![0])) as Record<
      string,
      unknown
    >;
    expect(line['transactionId']).toBeUndefined();
    expect(line['messageId']).toBe('msg-1');
  });
});
