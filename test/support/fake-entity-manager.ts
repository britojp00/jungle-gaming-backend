import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';
import { InboxMessageEntity } from '../../src/infrastructure/persistence/entities/inbox-message.entity.js';

export type Row = Record<string, unknown>;

/**
 * Fake que espelha a superfície real do `EntityManager` usada pelos use
 * cases (`transactional`, `create`, `persist`, `flush`, `findOne`,
 * `getReference`).
 *
 * Modela três comportamentos do PostgreSQL: a atomicidade (o que foi
 * confirmado é desfeito se a transação falhar) e as constraints únicas
 * `wallets_player_currency_unique` e `inbox_consumer_message_unique`. Isso
 * permite validar a ORQUESTRAÇÃO —
 * quais registros são criados, com quais campos, e como os eventos são
 * gravados na outbox dentro da mesma transação.
 *
 * NÃO substitui os testes de integração com PostgreSQL real, que cobrem a
 * concorrência entre instâncias e o rollback do banco. Essa fase é
 * posterior no plano.
 */
export class FakeEntityManager {
  readonly store = new Map<Function, Row[]>();

  /** Falha simulada no flush — exercita rollback. */
  failOnFlush = false;

  /** Falha simulada na consulta SQL bruta (ex.: banco indisponível no claim). */
  failOnExecute = false;

  /** Executado logo antes do flush — simula uma transação concorrente. */
  beforeFlush: (() => void) | null = null;

  /**
   * Linhas que a consulta de claim devolveria (`… FOR UPDATE SKIP LOCKED`).
   *
   * O fake NÃO executa SQL: o teste semeia o resultado, com os MESMOS nomes
   * de coluna do banco (`wallet_id`, `reference_attempts`, `created_at`),
   * porque é assim que o repositório os lê. O SQL real — filtro, ordenação,
   * `LIMIT`, `SKIP LOCKED` — é coberto pelos testes de integração.
   */
  claimRows: Row[] = [];

  /** Consultas SQL brutas recebidas, para asserção das chamadas. */
  executed: Array<{ sql: string; params: unknown[] }> = [];

  private staged: Row[] = [];
  private committed: Row[] = [];

  asEntityManager(): EntityManager {
    return this as unknown as EntityManager;
  }

  rows<T>(entityClass: Function): T[] {
    return (this.store.get(entityClass) ?? []) as T[];
  }

  seed(entityClass: Function, row: Row): void {
    const rows = this.store.get(entityClass) ?? [];
    rows.push(row);
    this.store.set(entityClass, rows);
  }

  async transactional<T>(
    cb: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    const stagedSnapshot = [...this.staged];
    this.committed = [];

    try {
      return await cb(this.asEntityManager());
    } catch (error) {
      // Rollback: desfaz apenas o que ESTA transação confirmou. Uma linha
      // inserida por uma transação concorrente (beforeFlush) sobrevive.
      for (const row of this.committed) {
        const rows = this.store.get(row.constructor) ?? [];
        const index = rows.indexOf(row);

        if (index >= 0) {
          rows.splice(index, 1);
        }
      }

      this.committed = [];
      this.staged = stagedSnapshot;
      throw error;
    }
  }

  create<T extends object>(entityClass: new () => T, data: Row): T {
    return Object.assign(new entityClass(), data);
  }

  persist(entity: Row): void {
    this.staged.push(entity);
  }

  getReference(entityClass: Function, id: string): Row {
    return { __reference: true, entityClass, id };
  }

  /**
   * O terceiro parâmetro (`options`, ex.: `lockMode`) é aceito e ignorado:
   * o fake não simula locks de linha.
   *
   * Modela também o filtro por PK de relação do MikroORM real:
   * `findOne(Entity, { wallet: id })` compara o FK da coluna, não o objeto
   * referência montado por `getReference` — aqui a célula `{__reference,
   * id}` é resolvida pelo `id`, como o MikroORM faria no SQL.
   */
  findOne(
    entityClass: Function,
    where: Row,
    _options?: Row,
  ): Row | null {
    const rows = this.store.get(entityClass) ?? [];

    const found = rows.find((row) =>
      Object.entries(where).every(([key, value]) => {
        const cell = row[key];

        if (
          cell !== null &&
          typeof cell === 'object' &&
          (cell as { __reference?: boolean }).__reference === true
        ) {
          return (cell as { id: string }).id === value;
        }

        return cell === value;
      }),
    );

    return found ?? null;
  }

  /**
   * SQL bruto (o claim do worker usa `FOR UPDATE SKIP LOCKED`, que não tem
   * equivalente em `findOne`). Devolve `claimRows` para a consulta de claim
   * e registra a chamada em `executed`; qualquer outra consulta devolve
   * vazio, como um banco sem linhas.
   */
  async execute(sql: string, params: unknown[] = []): Promise<Row[]> {
    this.executed.push({ sql, params });

    if (this.failOnExecute) {
      throw new Error('SIMULATED_CLAIM_FAILURE');
    }

    if (/for\s+update\s+skip\s+locked/i.test(sql)) {
      return [...this.claimRows];
    }

    return [];
  }

  /**
   * `UPDATE` direto, sem passar pelo identity map — é o caminho do claim
   * gravar a tentativa e a próxima janela. Modela o efeito (as linhas
   * encontradas são sobrescritas) e devolve a contagem, como faz o banco.
   */
  async nativeUpdate(
    entityClass: Function,
    where: Row,
    data: Row,
  ): Promise<number> {
    const rows = this.store.get(entityClass) ?? [];
    const matched = rows.filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    );

    for (const row of matched) {
      Object.assign(row, data);
    }

    return matched.length;
  }

  async flush(): Promise<void> {
    this.beforeFlush?.();

    if (this.failOnFlush) {
      throw new Error('SIMULATED_FLUSH_FAILURE');
    }

    // Reproduz as constraints únicas antes de aplicar qualquer linha, como
    // faz o banco: ou tudo entra, ou nada entra. As duas são de DOMÍNIO
    // distinto (`wallets_player_currency_unique` e
    // `inbox_consumer_message_unique`); o que está em jogo aqui é só a
    // orquestração do código — a garantia real é do PostgreSQL e é provada
    // nos testes de integração.
    for (const entity of this.staged) {
      if (entity instanceof WalletEntity) {
        const duplicated = this.rows<Row>(WalletEntity).some(
          (row) =>
            row.playerId === entity.playerId &&
            row.currency === entity.currency,
        );

        if (duplicated) {
          throw new UniqueConstraintViolationException(
            new Error(
              'duplicate key value violates unique constraint "wallets_player_currency_unique"',
            ),
          );
        }
      }

      if (entity instanceof InboxMessageEntity) {
        const duplicated = this.rows<Row>(InboxMessageEntity).some(
          (row) =>
            row.consumerName === entity.consumerName &&
            row.messageId === entity.messageId,
        );

        if (duplicated) {
          throw new UniqueConstraintViolationException(
            new Error(
              'duplicate key value violates unique constraint "inbox_consumer_message_unique"',
            ),
          );
        }
      }
    }

    for (const entity of this.staged) {
      const rows = this.store.get(entity.constructor) ?? [];
      rows.push(entity);
      this.store.set(entity.constructor, rows);
      this.committed.push(entity);
    }

    this.staged = [];
  }
}
