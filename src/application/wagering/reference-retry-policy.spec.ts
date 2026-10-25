import { describe, expect, it } from 'vitest';

import {
  hasExhaustedReferenceAttempts,
  isReferenceRetryExpired,
  nextReferenceAttemptAt,
  REFERENCE_RETRY_BASE_DELAY_MS,
  REFERENCE_RETRY_MAX_ATTEMPTS,
  REFERENCE_RETRY_MAX_DELAY_MS,
  REFERENCE_TTL_MS,
  referenceRetryDelayMs,
  shouldRejectMissingReference,
} from './reference-retry-policy.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-24T11:00:00.000Z');

describe('referenceRetryDelayMs — backoff exponencial (README §7.1)', () => {
  it('dobra a cada tentativa a partir de 5 s', () => {
    expect(referenceRetryDelayMs(1)).toBe(5_000);
    expect(referenceRetryDelayMs(2)).toBe(10_000);
    expect(referenceRetryDelayMs(3)).toBe(20_000);
    expect(referenceRetryDelayMs(4)).toBe(40_000);
    expect(referenceRetryDelayMs(5)).toBe(80_000);
    expect(referenceRetryDelayMs(6)).toBe(160_000);
    expect(referenceRetryDelayMs(7)).toBe(320_000);
    expect(referenceRetryDelayMs(8)).toBe(640_000);
  });

  it('respeita o teto de 15 min a partir da 9ª tentativa', () => {
    expect(referenceRetryDelayMs(9)).toBe(REFERENCE_RETRY_MAX_DELAY_MS);
    expect(referenceRetryDelayMs(10)).toBe(REFERENCE_RETRY_MAX_DELAY_MS);
    expect(referenceRetryDelayMs(REFERENCE_RETRY_MAX_ATTEMPTS + 1)).toBe(
      REFERENCE_RETRY_MAX_DELAY_MS,
    );
  });

  it('soma das esperas das 10 tentativas ≈ 53 min (justificativa do limite)', () => {
    let total = 0;

    for (let attempt = 1; attempt <= REFERENCE_RETRY_MAX_ATTEMPTS; attempt++) {
      total += referenceRetryDelayMs(attempt);
    }

    // 5+10+20+40+80+160+320+640+900+900 s = 3.075.000 ms = 51,25 min.
    expect(total).toBe(3_075_000);
    expect(total / 60_000).toBeCloseTo(51.25, 2);
  });

  it('é estável para tentativas fora da faixa (contador corrompido)', () => {
    expect(referenceRetryDelayMs(0)).toBe(REFERENCE_RETRY_BASE_DELAY_MS);
    expect(referenceRetryDelayMs(-5)).toBe(REFERENCE_RETRY_BASE_DELAY_MS);
    expect(referenceRetryDelayMs(1_000_000)).toBe(
      REFERENCE_RETRY_MAX_DELAY_MS,
    );
    expect(referenceRetryDelayMs(1_000_000)).not.toBe(Infinity);
  });
});

describe('nextReferenceAttemptAt — janela nunca além do TTL', () => {
  it('agenda o backoff a partir do instante atual', () => {
    const next = nextReferenceAttemptAt({
      attempts: 1,
      now: NOW,
      createdAt: CREATED_AT,
    });

    expect(next.toISOString()).toBe('2026-10-24T12:00:05.000Z');
  });

  it('usa a espera da tentativa recém-contada', () => {
    const next = nextReferenceAttemptAt({
      attempts: 3,
      now: NOW,
      createdAt: CREATED_AT,
    });

    expect(next.getTime()).toBe(NOW.getTime() + 20_000);
  });

  it('vencido o TTL, a janela cai no passado (linha elegível no próximo tick)', () => {
    const expired = new Date(NOW.getTime() - REFERENCE_TTL_MS - 60_000);

    const next = nextReferenceAttemptAt({
      attempts: 1,
      now: NOW,
      createdAt: expired,
    });

    // Independente do backoff: morre no prazo absoluto, nunca o ultrapassa.
    expect(next.getTime()).toBe(expired.getTime() + REFERENCE_TTL_MS);
    expect(next.getTime()).toBeLessThan(NOW.getTime());
  });

  it('não agenda além do prazo quando o backoff passaria dele', () => {
    // Faltam 10 s para o TTL, mas o backoff pediria 15 min.
    const createdAt = new Date(NOW.getTime() - REFERENCE_TTL_MS + 10_000);

    const next = nextReferenceAttemptAt({
      attempts: 9,
      now: NOW,
      createdAt,
    });

    expect(next.getTime()).toBe(createdAt.getTime() + REFERENCE_TTL_MS);
    expect(next.getTime()).toBeLessThan(
      NOW.getTime() + REFERENCE_RETRY_MAX_DELAY_MS,
    );
  });
});

describe('limites independentes — tentativas e TTL (README §7.1)', () => {
  it('esgota na 10ª tentativa', () => {
    expect(hasExhaustedReferenceAttempts(REFERENCE_RETRY_MAX_ATTEMPTS - 1)).toBe(
      false,
    );
    expect(hasExhaustedReferenceAttempts(REFERENCE_RETRY_MAX_ATTEMPTS)).toBe(
      true,
    );
    expect(hasExhaustedReferenceAttempts(REFERENCE_RETRY_MAX_ATTEMPTS + 50)).toBe(
      true,
    );
  });

  it('o TTL conta da criação, não da última tentativa', () => {
    expect(
      isReferenceRetryExpired({ createdAt: CREATED_AT, now: NOW }),
    ).toBe(false); // 1 h

    expect(
      isReferenceRetryExpired({
        createdAt: new Date(NOW.getTime() - REFERENCE_TTL_MS + 1),
        now: NOW,
      }),
    ).toBe(false);

    expect(
      isReferenceRetryExpired({
        createdAt: new Date(NOW.getTime() - REFERENCE_TTL_MS),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rejeita quando QUALQUER limite vence — um não depende do outro', () => {
    const fresh = { createdAt: CREATED_AT, now: NOW };

    // Poucas tentativas e TTL venceu → rejeita.
    expect(shouldRejectMissingReference({ attempts: 1, ...fresh })).toBe(false);
    expect(
      shouldRejectMissingReference({
        attempts: 1,
        createdAt: new Date(NOW.getTime() - REFERENCE_TTL_MS),
        now: NOW,
      }),
    ).toBe(true);

    // Tentativas esgotadas e TTL venceu NÃO → rejeita.
    expect(
      shouldRejectMissingReference({
        attempts: REFERENCE_RETRY_MAX_ATTEMPTS,
        ...fresh,
      }),
    ).toBe(true);

    // Nenhum limite venceu → segue esperando.
    expect(
      shouldRejectMissingReference({
        attempts: REFERENCE_RETRY_MAX_ATTEMPTS - 1,
        ...fresh,
      }),
    ).toBe(false);
  });
});
