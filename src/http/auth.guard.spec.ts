import { describe, expect, it } from 'vitest';

import { AuthGuard } from './auth.guard.js';

/**
 * README §2: autenticação não implementada é aceita, desde que o ponto de
 * extensão fique explícito no código. O guard é no-op e não altera o
 * contrato HTTP.
 */
describe('AuthGuard — ponto de extensão de autenticação (§2)', () => {
  it('no-op: autoriza qualquer requisição até ser substituído por um IdP real', () => {
    const guard = new AuthGuard();

    expect(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as never),
    ).toBe(true);
  });
});
