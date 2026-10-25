import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';

import { httpError } from './http-errors.js';

/**
 * Um único ponto de mapeamento de erro para TODOS os endpoints (README §9:
 * "de forma consistente entre todos os endpoints"). Quem escreve a resposta é
 * `httpError`, que traduz o erro do domínio/caso de uso para o status certo.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const mapped = httpError(exception);

    response
      .status(mapped.getStatus())
      .json(mapped.getResponse() as Record<string, unknown>);
  }
}
