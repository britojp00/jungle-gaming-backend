import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from './metrics.js';

/**
 * Contrato do §12 (mínimo): transações por status, duplicatas detectadas,
 * retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de
 * processamento — todos representáveis no snapshot exposto em `GET /metrics`.
 */
describe('MetricsRegistry', () => {
  it('conta séries por nome e labels, com labels em ordem estável', () => {
    const registry = new MetricsRegistry();

    registry.increment('wager_transactions_total', {
      status: 'PROCESSED',
      kind: 'BET',
    });
    registry.increment('wager_transactions_total', {
      kind: 'BET',
      status: 'PROCESSED',
    });
    registry.increment('wager_transactions_total', {
      status: 'REJECTED',
      kind: 'BET',
    });

    expect(registry.snapshot()['counters']).toEqual({
      'wager_transactions_total{kind=BET,status=PROCESSED}': 2,
      'wager_transactions_total{kind=BET,status=REJECTED}': 1,
    });
  });

  it('registra gauges e durações com contagem, total, máximo e média', () => {
    const registry = new MetricsRegistry();

    registry.setGauge('batch_size', 10);
    registry.observeDuration('outbox_lag_ms', 100);
    registry.observeDuration('outbox_lag_ms', 300);

    const snapshot = registry.snapshot();
    expect(snapshot['gauges']).toEqual({ batch_size: 10 });
    expect(snapshot['durations']).toEqual({
      outbox_lag_ms: { count: 2, totalMs: 400, maxMs: 300, avgMs: 200 },
    });
  });

  it('o cronômetro observa a duração decorrida', () => {
    const registry = new MetricsRegistry();

    const stop = registry.startDuration('processing_latency_ms', {
      component: 'consumer',
    });
    stop();

    const durations = registry.snapshot()['durations'] as Record<
      string,
      { count: number }
    >;
    expect(durations['processing_latency_ms{component=consumer}']!.count).toBe(1);
  });

  it('reset limpa todas as séries (somente testes)', () => {
    const registry = new MetricsRegistry();

    registry.increment('dlq_messages_total');
    registry.reset();

    expect(registry.snapshot()).toMatchObject({
      counters: {},
      gauges: {},
      durations: {},
    });
  });
});
