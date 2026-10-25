
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallets_player_currency_unique',
  properties: ['playerId', 'currency'],
})
@Check({
  name: 'wallets_balance_non_negative',
  expression: 'balance >= 0',
})
@Check({
  name: 'wallets_version_positive',
  expression: 'version >= 1',
})
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ name: 'player_id', type: 'string', length: 255 })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'integer', default: 1 })
  version = 1;

  @Property({
    name: 'created_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
  })
  createdAt = new Date();

  @Property({
    name: 'updated_at',
    type: 'timestamptz',
    defaultRaw: 'now()',
    onUpdate: () => new Date(),
  })
  updatedAt = new Date();
}
