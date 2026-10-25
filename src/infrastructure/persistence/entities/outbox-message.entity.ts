
import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

export enum OutboxMessageStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
}

@Entity({ tableName: 'outbox_messages' })
@Check({
  name: 'outbox_attempts_non_negative',
  expression: 'attempts >= 0',
})
@Check({
  name: 'outbox_status_valid',
  expression: "status IN ('PENDING', 'PROCESSING', 'PUBLISHED')",
})
@Index({
  name: 'outbox_status_next_attempt_idx',
  properties: ['status', 'nextAttemptAt', 'createdAt'],
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ name: 'event_type', type: 'string', length: 100 })
  eventType!: string;

  @Property({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({
    type: 'string',
    length: 20,
    default: OutboxMessageStatus.PENDING,
  })
  status = OutboxMessageStatus.PENDING;

  @Property({ type: 'integer', default: 0 })
  attempts = 0;

  @Property({
    name: 'next_attempt_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  nextAttemptAt = new Date();

  @Property({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt: Date | null = null;

  @Property({ name: 'lock_owner', type: 'string', length: 255, nullable: true })
  lockOwner: string | null = null;

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null = null;

  @Property({
    name: 'occurred_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  occurredAt = new Date();

  @Property({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null = null;

  @Property({
    name: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt = new Date();
}
