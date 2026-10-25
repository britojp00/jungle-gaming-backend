/**
 * Porta de publicação da outbox (README §11).
 *
 * Quem conhece o evento é o domínio/aplicação; quem conhece o transporte é a
 * implementação em `infrastructure/sqs`. O worker publica o envelope que já
 * foi gravado em `outbox_messages.payload` — sem reescrever `data` (que
 * continua em `MoneyProps`, §11) e sem inventar um novo contrato.
 */
export interface OutboxPublishing {
  /** id da mensagem na outbox — é o `eventId` do envelope. */
  messageId: string;

  /** `aggregateId` do envelope — usado como agrupador de ordenação do FIFO. */
  aggregateId: string;

  /**
   * Envelope já serializado na outbox, publicado **sem alteração de
   * conteúdo** — o que sai é o que foi gravado (a comparação em teste é entre
   * objetos JSON parseados, não entre bytes).
   */
  payload: Record<string, unknown>;
}

export interface OutboxPublisher {
  /** Publica uma mensagem. Falha lança erro; quem chama agenda nova tentativa. */
  publish(message: OutboxPublishing): Promise<void>;
}
