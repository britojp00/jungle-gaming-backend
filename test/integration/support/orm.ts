import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';

import {
  assertDedicatedIntegrationDatabase,
  integrationEnv,
  integrationTables,
} from './env.js';

let orm: MikroORM | null = null;

/**
 * Sobe o MikroORM contra o PostgreSQL EXCLUSIVO de integração e aplica as
 * migrations existentes apenas ali.
 *
 * Se o container estiver indisponível, o `init` rejeita e a suíte falha
 * com o erro original de conexão — nada é engolido nem contornado com fakes.
 */
export async function bootstrapIntegrationOrm(): Promise<MikroORM> {
  if (orm) {
    return orm;
  }

  assertDedicatedIntegrationDatabase(integrationEnv.databaseUrl);

  orm = await MikroORM.init({
    clientUrl: integrationEnv.databaseUrl,
    entities: ['./src/**/*.entity.ts'],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      pathTs: './src/migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: true,
      emit: 'ts',
    },
  });

  // Migrations rodam somente no banco de integração. Nenhum arquivo novo é
  // criado: usa exatamente as migrations já versionadas do projeto.
  await orm.migrator.up();

  return orm;
}

export async function disposeIntegrationOrm(): Promise<void> {
  if (!orm) {
    return;
  }

  await orm.close(true);
  orm = null;
}

/**
 * Zera as tabelas da aplicação entre testes para que a execução seja
 * previsível e não dependa de dados residuais.
 *
 * Passa pela trava de segurança: só executa em banco `_integration`.
 */
export async function truncateIntegrationTables(): Promise<void> {
  const activeOrm = await bootstrapIntegrationOrm();
  const connection = activeOrm.em.getConnection();

  await connection.execute(
    `truncate table ${integrationTables.join(', ')} restart identity cascade`,
  );
}
