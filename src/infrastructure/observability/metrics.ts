/**
 * Métricas operacionais (README §12) **em memória**, sem dependências novas.
 *
 * O §12 exige, no mínimo: transações por status, duplicatas detectadas,
 * retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de
 * processamento. OpenTelemetry e dashboard são opcionais, então o registro é
 * deliberadamente pequeno: contadores monotônicos, gauges e observações de
 * duração, expostos como JSON em `GET /metrics`.
 *
 * Limitação honesta (registrada em `ARCHITECTURE.md`): o registro é por
 * processo — com múltiplas instâncias, cada `/metrics` reporta a própria.
 */

export type MetricLabels = Readonly<Record<string, string | number>>;

interface DurationSeries {
  count: number;
  totalMs: number;
  maxMs: number;
}

/** Chave da série: nome + labels ordenados (série estável entre chamadas). */
function keyOf(name: string, labels?: MetricLabels): string {
  const entries = Object.entries(labels ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return entries.length === 0
    ? name
    : `${name}{${entries.map(([key, value]) => `${key}=${value}`).join(',')}}`;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly durations = new Map<string, DurationSeries>();

  /** Contador monotônico (só soma) — ex.: `dlq_messages_total`. */
  increment(name: string, labels?: MetricLabels, value = 1): void {
    const key = keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  /** Valor instantâneo — ex.: tamanho de lote. */
  setGauge(name: string, value: number, labels?: MetricLabels): void {
    this.gauges.set(keyOf(name, labels), value);
  }

  /** Observação de duração (contagem, total, máximo e média) — ex.: latência. */
  observeDuration(name: string, durationMs: number, labels?: MetricLabels): void {
    const key = keyOf(name, labels);
    const series = this.durations.get(key) ?? {
      count: 0,
      totalMs: 0,
      maxMs: 0,
    };

    series.count += 1;
    series.totalMs += durationMs;
    series.maxMs = Math.max(series.maxMs, durationMs);
    this.durations.set(key, series);
  }

  /** Cronômetro: chame a função devolvida para registrar a duração. */
  startDuration(name: string, labels?: MetricLabels): () => void {
    const startedAt = performance.now();

    return () => this.observeDuration(name, performance.now() - startedAt, labels);
  }

  /** Estado atual, serializável diretamente em `GET /metrics` (§12). */
  snapshot(): Record<string, unknown> {
    const durations: Record<string, unknown> = {};

    for (const [key, series] of this.durations) {
      durations[key] = {
        count: series.count,
        totalMs: Math.round(series.totalMs * 1000) / 1000,
        maxMs: Math.round(series.maxMs * 1000) / 1000,
        avgMs:
          series.count === 0
            ? 0
            : Math.round((series.totalMs / series.count) * 1000) / 1000,
      };
    }

    return {
      observedAt: new Date().toISOString(),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      durations,
    };
  }

  /** Uso exclusivo de testes — não há caminho de produção que limpe. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.durations.clear();
  }
}

/** Registro do processo: o mesmo objeto em todos os pontos instrumentados. */
export const metrics = new MetricsRegistry();
