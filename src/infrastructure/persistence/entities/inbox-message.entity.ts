
import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { InboxMessageStatus } from '../../../domain/messaging/inbox-message.js';

// Re-export para manter os imports atuais desta camada (mesmo padrão de
// `wager-transaction.entity.ts`): o enum pertence ao domínio — a entidade de
// persistência não define regra de negócio.
export { InboxMessageStatus };

@Entity({ tableName: 'inbox_messages' })
@Unique({
  name: 'inbox_consumer_message_unique',
  properties: ['consumerName', 'messageId'],
})
@Check({
  name: 'inbox_attempts_non_negative',
  expression: 'attempts >= 0',
})
@Check({
  name: 'inbox_status_valid',
  expression:
    "status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')",
})
@Index({
  name: 'inbox_status_created_idx',
  properties: ['status', 'createdAt'],
})
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ name: 'consumer_name', type: 'string', length: 100 })
  consumerName!: string;

  @Property({ name: 'message_id', type: 'string', length: 255 })
  messageId!: string;

  @Property({ name: 'event_type', type: 'string', length: 100 })
  eventType!: string;

  @Property({ name: 'payload_hash', type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({
    type: 'string',
    length: 20,
    default: InboxMessageStatus.RECEIVED,
  })
  status = InboxMessageStatus.RECEIVED;

  @Property({ type: 'integer', default: 0 })
  attempts = 0;

  @Property({ name: 'next_attempt_at', type: 'timestamptz', defaultRaw: 'now()' })
  nextAttemptAt = new Date();

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null = null;

  @Property({ name: 'received_at', type: 'timestamptz', defaultRaw: 'now()' })
  receivedAt = new Date();

  @Property({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null = null;

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt = new Date();

  @Property({
    name: 'updated_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
    onUpdate: () => new Date(),
  })
  updatedAt = new Date();
}
