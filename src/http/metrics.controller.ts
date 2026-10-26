import { Controller, Get } from '@nestjs/common';

import { metrics } from '../infrastructure/observability/metrics.js';

/**
 * Exposição das métricas operacionais (README §12) como JSON — o mesmo
 * formato do snapshot de `MetricsRegistry`: contadores, gauges e durações.
 * Assim como os health checks, não exige autenticação (§2).
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  snapshot(): Record<string, unknown> {
    return metrics.snapshot();
  }
}
