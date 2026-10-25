/**
 * Política de reprocessamento das linhas `PENDING_REFERENCE` (README §7.1:
 * "worker agendado com backoff exponencial. Limite de tentativas ou TTL
 * definido e justificado por você").
 *
 * Módulo puro, sem ORM nem Nest: é o único lugar que conhece os números, e
 * por isso é testável sem banco (escolhas e justificativas registradas em
 * `ARCHITECTURE.md`).
 *
 * ## Parâmetros
 *
 * | Parâmetro | Valor | Por quê |
 * |---|---|---|
 * | base | 5 s | entrega fora de ordem entre provedor e plataforma se resolve em segundos; 5 s evita a primeira reavaliação prematura sem segurar a fila |
 * | fator | 2 | backoff exponencial pedido pela §7.1 |
 * | teto de espera | 15 min | limita o intervalo entre tentativas para que uma referência que chegue tarde seja resolvida no mesmo dia útil |
 * | tentativas | 10 | 5+10+20+40+80+160+320+640+900+900 s = 3.075 s ≈ 51 min de tentativas antes do esgotamento |
 * | TTL absoluto | 6 h | rede de segurança independente do contador: cobre downtime longo do worker (que congela as tentativas) sem reter transação indefinidamente |
 *
 * As duas limitações são complementares e verificadas **independentemente**
 * (§7.1 admite "limite de tentativas **ou** TTL"): as tentativas limitam a
 * rajada de reprocessamento, o TTL limita a idade da pendência.
 */

/** Espera da 1ª tentativa para a 2ª, em milissegundos. */
export const REFERENCE_RETRY_BASE_DELAY_MS = 5_000;

/** Multiplicador do backoff exponencial a cada tentativa. */
export const REFERENCE_RETRY_BACKOFF_FACTOR = 2;

/** Teto de uma única espera (15 min). */
export const REFERENCE_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;

/** Tentativas máximas antes de `REJECTED` + `REFERENCE_NOT_FOUND`. */
export const REFERENCE_RETRY_MAX_ATTEMPTS = 10;

/** Idade máxima de uma pendência (6 h) a partir de `created_at`. */
export const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Espera antes da próxima tentativa, dado o número de tentativas já
 * consumidas: `min(base × 2^(tentativa−1), teto)`.
 *
 * 1 tentativa → 5 s, 2 → 10 s, … 8 → 640 s, 9 e 10 → 900 s (teto).
 * O expoente é truncado muito acima do máximo real para que a conta não
 * estoure `Number.MAX_SAFE_INTEGER` com um contador corrompido.
 */
export function referenceRetryDelayMs(attempts: number): number {
  const safeAttempts = Math.min(Math.max(attempts, 1), 31);
  const delay =
    REFERENCE_RETRY_BASE_DELAY_MS *
    REFERENCE_RETRY_BACKOFF_FACTOR ** (safeAttempts - 1);

  return Math.min(delay, REFERENCE_RETRY_MAX_DELAY_MS);
}

/**
 * Próxima janela de elegibilidade.
 *
 * O backoff NUNCA agenda uma linha além do prazo absoluto:
 * `min(now + backoff, created_at + TTL)`. Vencido o TTL, a janela cai no
 * passado e a linha volta a ser elegível a cada tick — é assim que o TTL é
 * verificado independentemente da próxima janela de retry, sem deixar uma
 * pendência expirada esperando a espera de backoff.
 */
export function nextReferenceAttemptAt(input: {
  attempts: number;
  now: Date;
  createdAt: Date;
}): Date {
  const scheduled = input.now.getTime() + referenceRetryDelayMs(input.attempts);
  const deadline = input.createdAt.getTime() + REFERENCE_TTL_MS;

  return new Date(Math.min(scheduled, deadline));
}

/** §7.1: esgotadas as tentativas → `REJECTED` + `REFERENCE_NOT_FOUND`. */
export function hasExhaustedReferenceAttempts(attempts: number): boolean {
  return attempts >= REFERENCE_RETRY_MAX_ATTEMPTS;
}

/** TTL absoluto vencido, contado a partir de `created_at`. */
export function isReferenceRetryExpired(input: {
  createdAt: Date;
  now: Date;
}): boolean {
  return input.now.getTime() - input.createdAt.getTime() >= REFERENCE_TTL_MS;
}

/**
 * Decisão de rejeição quando a referência AINDA não existe, avaliada
 * independentemente uma da outra (tentativas e TTL) e apenas depois de
 * tentar resolver: se a referência chegou, resolve-se mesmo com o TTL
 * vencido — rejeitar nesse caso descartaria uma transação recuperável.
 */
export function shouldRejectMissingReference(input: {
  attempts: number;
  createdAt: Date;
  now: Date;
}): boolean {
  return (
    hasExhaustedReferenceAttempts(input.attempts) ||
    isReferenceRetryExpired(input)
  );
}
