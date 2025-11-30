import { FastifyReply } from 'fastify';
import { HTTP_STATUS } from '@/http-status-codes';
import { isAuthError } from '@/auth/errors';

export function respondWithError(
  reply: FastifyReply,
  error: unknown,
  defaultMessage = 'Invalid request'
) {
  if (isAuthError(error)) {
    return reply.status(HTTP_STATUS.UNAUTHORIZED).send({ error: 'Invalid token' });
  }
  return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: defaultMessage });
}
