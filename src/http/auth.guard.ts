import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (README §2), explicitamente **no-op**.
 *
 * O desafio não pontua autenticação e aceita não implementá-la, desde que a
 * decisão seja documentada e o ponto de extensão fique explícito no código
 * ("por exemplo um `AuthGuard` no-op ou um `ProviderIdentityPort`"). Este
 * guard é esse ponto: registrados os endpoints de negócio, a troca por um
 * guard real (validação de JWT de um IdP externo — Keycloak/Zitadel, OIDC)
 * acontece aqui, sem tocar nos controllers.
 *
 * Escopo oficial do que a autenticação **não** cobre: os endpoints de health
 * (`/health/live`, `/health/ready`) continuam abertos — quando este guard for
 * substituído, a isenção deles deve ser mantida. Mensagens vindas da fila são
 * canal interno confiável; a identidade do provedor dentro da mensagem segue
 * sujeita às mesmas validações de domínio (ProviderIdentityPort seria o ponto
 * de extrair essa identidade do envelope).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
