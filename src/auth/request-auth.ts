import { FastifyRequest } from 'fastify';
import { AppError } from '@/utils/app-error';
import { extractTokenFromHeader, verifyAccessToken, type JWTPayload } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { defineAbilityFor, type AppAbility } from '@/rbac';

type RequestAuthContext = {
  payload: JWTPayload;
  ability: AppAbility;
};

const REQUEST_AUTH_KEY = Symbol.for('signhex.requestAuth');
type RequestWithAuth = FastifyRequest & { [REQUEST_AUTH_KEY]?: RequestAuthContext };

function isSessionActive(
  session: { user_id: string; expires_at: Date } | null,
  userId: string
): boolean {
  if (!session) return false;
  if (session.user_id !== userId) return false;
  return session.expires_at.getTime() > Date.now();
}

export async function chatAuthPreHandler(request: FastifyRequest): Promise<void> {
  const token = extractTokenFromHeader(request.headers.authorization);
  if (!token) {
    throw AppError.unauthorized('Missing authorization header');
  }

  const payload = await verifyAccessToken(token);
  const sessionRepo = createSessionRepository();
  const session = await sessionRepo.findByJti(payload.jti);
  if (!isSessionActive(session, payload.sub)) {
    throw AppError.unauthorized('Token has been revoked');
  }

  const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
  (request as RequestWithAuth)[REQUEST_AUTH_KEY] = { payload, ability } satisfies RequestAuthContext;
}

export function getRequestAuthContext(request: FastifyRequest): RequestAuthContext {
  const auth = (request as RequestWithAuth)[REQUEST_AUTH_KEY];
  if (!auth) throw AppError.unauthorized('Unauthorized');
  return auth;
}
