/**
 * Configuração EXCLUSIVA do ambiente de integração.
 *
 * Estes valores nunca vêm de `DATABASE_URL` nem de `SQS_*`: banco e filas de
 * integração são separados dos de desenvolvimento, então um teste de
 * integração não consegue — mesmo por engano — tocar no ambiente de dev.
 */

const FALLBACK_INTEGRATION_DATABASE_URL =
  'postgresql://wagering_integration:integration_only_change_me@127.0.0.1:5433/wagering_integration';

export const integrationEnv = {
  databaseUrl:
    process.env.INTEGRATION_DATABASE_URL ??
    FALLBACK_INTEGRATION_DATABASE_URL,

  sqsEndpoint:
    process.env.INTEGRATION_SQS_ENDPOINT ?? 'http://127.0.0.1:4567',

  /** Fila de entrada de comandos dos provedores (README §10). */
  sqsQueueName:
    process.env.INTEGRATION_SQS_QUEUE_NAME ??
    'jungle-integration-wager-transactions.fifo',

  /** Fila de saída dos eventos da outbox (README §11) — dedicada, também FIFO. */
  sqsEventsQueueName:
    process.env.INTEGRATION_SQS_EVENTS_QUEUE_NAME ??
    'jungle-integration-wager-events.fifo',

  region: process.env.AWS_REGION ?? 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
} as const;

/** Colunas apagadas entre testes, em ordem compatível com as FKs. */
export const integrationTables = [
  'wallet_ledger_entries',
  'wager_transactions',
  'outbox_messages',
  'inbox_messages',
  'wallets',
] as const;

/**
 * Trava de segurança: opera somente em um banco cujo nome termina com
 * `_integration`.
 *
 * Qualquer operação destrutiva (truncate) ou de preparação (migrations)
 * passa por aqui primeiro. Assim um valor errado de variável de ambiente
 * derruba a suíte com mensagem explícita em vez de apagar o banco de
 * desenvolvimento.
 */
export function assertDedicatedIntegrationDatabase(
  databaseUrl: string,
): string {
  let databaseName: string;

  try {
    databaseName = decodeURIComponent(
      new URL(databaseUrl).pathname.replace(/^\//, ''),
    );
  } catch {
    throw new Error(
      `INTEGRATION_DATABASE_URL inválida: "${databaseUrl}".`,
    );
  }

  if (!databaseName.endsWith('_integration')) {
    throw new Error(
      `Recusando executar a suíte de integração contra o banco "${databaseName}". ` +
        'O nome precisa terminar com "_integration" para não arriscar o ambiente de desenvolvimento.',
    );
  }

  return databaseName;
}
