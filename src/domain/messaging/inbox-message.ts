/**
 * Mensagem recebida e registrada para consumo **idempotente** (README §6.5 e
 * §10).
 *
 * A Inbox existe para que um redelivery — ou um reinício entre o commit e a
 * confirmação — não duplique efeitos: a chave lógica
 * `(consumerName, messageId)` é única **no banco**
 * (`inbox_consumer_message_unique`), e o registro nasce na mesma transação
 * dos efeitos financeiros (§11). Nada aqui depende de memória.
 *
 * §6.0: construtor privado + factories estáticas; `rehydrate` **não**
 * revalida regras de transição — só reconstrói estado já persistido.
 */

/**
 * Estados previstos pelo schema (`inbox_status_valid`): o registro acompanha
 * o ciclo do consumo. Nenhum estado fora desta lista é aceito.
 */
export enum InboxMessageStatus {
  RECEIVED = 'RECEIVED',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

export interface ReceiveInboxProps {
  id: string;
  consumerName: string;
  messageId: string;
  eventType: string;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
  receivedAt?: Date;
}

export interface RehydrateInboxMessageProps {
  id: string;
  consumerName: string;
  messageId: string;
  eventType: string;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
  status: InboxMessageStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class InboxMessage {
  private currentStatus: InboxMessageStatus;
  private currentProcessedAt: Date | null;
  private currentUpdatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly eventType: string,
    public readonly payloadHash: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    status: InboxMessageStatus,
    public readonly attempts: number,
    public readonly nextAttemptAt: Date,
    public readonly lastError: string | null,
    public readonly receivedAt: Date,
    processedAt: Date | null,
    public readonly createdAt: Date,
    updatedAt: Date,
  ) {
    this.currentStatus = status;
    this.currentProcessedAt = processedAt ? new Date(processedAt) : null;
    this.currentUpdatedAt = new Date(updatedAt);
  }

  /**
   * Registra uma mensagem recebida (README §6.5 `receive`).
   *
   * Nasce `RECEIVED`, com zero tentativas e sem erro: `attempts`,
   * `nextAttemptAt` e `lastError` acompanham o schema e serão escritos pela
   * etapa de consumo (§10), que é quem conhece retry/backoff.
   */
  static receive(props: ReceiveInboxProps): InboxMessage {
    InboxMessage.assertRequiredText('Inbox ID', props.id);
    InboxMessage.assertRequiredText('Consumer name', props.consumerName);
    InboxMessage.assertRequiredText('Message ID', props.messageId);
    InboxMessage.assertRequiredText('Event type', props.eventType);
    InboxMessage.assertRequiredText('Payload hash', props.payloadHash);

    // Limites das colunas correspondentes (migration inicial).
    InboxMessage.assertMaxLength('Consumer name', props.consumerName, 100);
    InboxMessage.assertMaxLength('Message ID', props.messageId, 255);
    InboxMessage.assertMaxLength('Event type', props.eventType, 100);
    InboxMessage.assertPayloadHash(props.payloadHash);
    InboxMessage.assertPayload(props.payload);

    const receivedAt = props.receivedAt ?? new Date();
    InboxMessage.assertValidDate(receivedAt);

    return new InboxMessage(
      props.id,
      props.consumerName,
      props.messageId,
      props.eventType,
      props.payloadHash,
      props.payload,
      InboxMessageStatus.RECEIVED,
      0,
      new Date(receivedAt),
      null,
      new Date(receivedAt),
      null,
      new Date(receivedAt),
      new Date(receivedAt),
    );
  }

  /** Reconstrução a partir da persistência — não revalida (README §6.0). */
  static rehydrate(props: RehydrateInboxMessageProps): InboxMessage {
    return new InboxMessage(
      props.id,
      props.consumerName,
      props.messageId,
      props.eventType,
      props.payloadHash,
      props.payload,
      props.status,
      props.attempts,
      props.nextAttemptAt,
      props.lastError,
      props.receivedAt,
      props.processedAt,
      props.createdAt,
      props.updatedAt,
    );
  }

  get status(): InboxMessageStatus {
    return this.currentStatus;
  }

  get processedAt(): Date | null {
    return this.currentProcessedAt ? new Date(this.currentProcessedAt) : null;
  }

  get updatedAt(): Date {
    return new Date(this.currentUpdatedAt);
  }

  isProcessed(): boolean {
    return this.currentStatus === InboxMessageStatus.PROCESSED;
  }

  /**
   * Marca a mensagem como processada (README §6.5 `markProcessed`).
   *
   * Repetir é **no-op idempotente** e preserva o `processedAt` original: a
   * Inbox existe para tornar o redelivery seguro (§10), então marcar de novo
   * uma mensagem já processada não pode ser erro nem sobrescrever o
   * resultado (§7, regra 7). Mesma convenção de `markPendingReference`.
   */
  markProcessed(at: Date): void {
    InboxMessage.assertValidDate(at);

    if (this.isProcessed()) {
      return;
    }

    this.currentStatus = InboxMessageStatus.PROCESSED;
    this.currentProcessedAt = new Date(at);
    this.currentUpdatedAt = new Date(at);
  }

  private static assertRequiredText(field: string, value: string): void {
    if (!value || !value.trim()) {
      throw new Error(`${field} is required`);
    }
  }

  private static assertMaxLength(
    field: string,
    value: string,
    max: number,
  ): void {
    if (value.length > max) {
      throw new Error(`${field} must be at most ${max} characters`);
    }
  }

  /**
   * Mesmo algoritmo documentado para `payloadHash` (README §9: hash de JSON
   * canônico, SHA-256 em hexadecimal minúsculo) e o mesmo limite da coluna
   * `varchar(64)` da migration inicial.
   */
  private static assertPayloadHash(value: string): void {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(
        'Payload hash must be a 64-character lowercase hex digest',
      );
    }
  }

  private static assertPayload(
    payload: Readonly<Record<string, unknown>>,
  ): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload must be an object');
    }
  }

  private static assertValidDate(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }
  }
}
