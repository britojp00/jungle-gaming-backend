import { EntityManager } from '@mikro-orm/postgresql';

import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';

/**
 * Persistência da Inbox (README §6.5, §10 e §11).
 *
 * A idempotência do consumo vem da restrição **única** `(consumer_name,
 * message_id)` do banco (`inbox_consumer_message_unique`) — nunca de memória
 * (§5.2). Este repositório não deduplica: salvar uma chave repetida deixa a
 * `UniqueConstraintViolationException` subir para quem chama, que decide o
 * que fazer com a corrida.
 *
 * Tudo roda na transação corrente do `EntityManager`, para que o registro da
 * Inbox possa ir **na mesma transação SQL** dos efeitos financeiros (§11) —
 * a coordenação com BET/WIN é etapa seguinte.
 */
export class InboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Chave lógica da Inbox (§10): `(consumerName, messageId)`. Devolve a
   * mensagem registrada, de modo que quem chama distinga uma já processada
   * (`isProcessed()`) de uma ainda pendente.
   */
  async findByMessageKey(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageEntity, {
      consumerName,
      messageId,
    });

    return entity ? this.toDomain(entity) : null;
  }

  /**
   * Persiste a mensagem recebida e, depois, a conclusão do processamento
   * (§6.5 `markProcessed`): insere quando é nova e atualiza quando já existe.
   *
   * Quem chama aplica a regra de domínio (`InboxMessage.markProcessed`) e
   * grava aqui — assim status, `processed_at`, tentativas e `last_error`
   * seguem no mesmo commit dos efeitos.
   */
  async save(message: InboxMessage): Promise<void> {
    const entity = await this.em.findOne(InboxMessageEntity, {
      id: message.id,
    });

    if (entity) {
      entity.status = message.status;
      entity.attempts = message.attempts;
      entity.nextAttemptAt = message.nextAttemptAt;
      entity.lastError = message.lastError;
      entity.processedAt = message.processedAt;
      entity.updatedAt = message.updatedAt;

      await this.em.flush();

      return;
    }

    this.em.persist(
      this.em.create(InboxMessageEntity, {
        id: message.id,
        consumerName: message.consumerName,
        messageId: message.messageId,
        eventType: message.eventType,
        payloadHash: message.payloadHash,
        payload: { ...message.payload },
        status: message.status,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        lastError: message.lastError,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      }),
    );

    await this.em.flush();
  }

  private toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      id: entity.id,
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      eventType: entity.eventType,
      payloadHash: entity.payloadHash,
      payload: entity.payload,
      status: entity.status,
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt,
      lastError: entity.lastError,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
