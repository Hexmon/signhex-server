import { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
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

  if (error instanceof ZodError) {
    const details = error.errors.map((issue) => {
      const path = issue.path.join('.') || 'root';
      const message =
        issue.code === 'invalid_enum_value'
          ? `${path} must be one of ${issue.options.join(', ')}`
          : issue.message;

      return {
        path,
        message,
        code: issue.code,
      };
    });

    const errorMessage = details[0]?.message ?? defaultMessage;
    return reply.status(HTTP_STATUS.BAD_REQUEST).send({
      error: errorMessage,
      details,
    });
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const pgError = error as any;

    if (pgError.code === '23505') {
      const constraint = pgError.constraint as string | undefined;
      const detail = pgError.detail || pgError.message || 'Unique constraint violated';

      let friendlyMessage = 'Resource already exists';
      if (constraint?.includes('email')) {
        friendlyMessage = 'Email already exists';
      }

      return reply.status(HTTP_STATUS.CONFLICT).send({
        error: friendlyMessage,
        detail,
      });
    }
  }

  return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: defaultMessage });
}
