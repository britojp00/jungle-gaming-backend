import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { SqsClient } from '../infrastructure/sqs/sqs-client.js';

/**
 * Health checks (README §9 e §12): `live` para processo vivo e `ready` para
 * PostgreSQL **e** SQS alcançáveis. Não exigem autenticação (§2).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get('live')
  live(): Record<string, string> {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Record<string, string>> {
    const checks: Record<string, string> = {
      postgres: 'ok',
      sqs: 'ok',
    };

    try {
      await this.em.getConnection().execute('select 1');
    } catch {
      checks['postgres'] = 'unreachable';
    }

    try {
      await new SqsClient({
        endpoint: process.env['SQS_ENDPOINT'] ?? '',
        region: process.env['AWS_REGION'] ?? 'us-east-1',
        accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      }).call('ListQueues');
    } catch {
      checks['sqs'] = 'unreachable';
    }

    const ready = checks['postgres'] === 'ok' && checks['sqs'] === 'ok';

    if (!ready) {
      throw new HttpException(
        { status: 'unavailable', ...checks },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ok', ...checks };
  }
}
