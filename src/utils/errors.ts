import { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { isAuthError } from '@/auth/errors';
import { AppError } from '@/utils/app-error';

type PgError = {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
};

const statusCodeMap: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Bad request.' },
  401: { code: 'UNAUTHORIZED', message: 'Unauthorized.' },
  403: { code: 'FORBIDDEN', message: 'Forbidden.' },
  404: { code: 'NOT_FOUND', message: 'Not found.' },
  409: { code: 'CONFLICT', message: 'Conflict.' },
  422: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
};

function mapStatusToAppError(statusCode: number, message?: string) {
  const mapped = statusCodeMap[statusCode];
  if (mapped?.code === 'VALIDATION_ERROR') {
    return AppError.validation(null);
  }
  if (mapped) {
    return new AppError({
      statusCode,
      code: mapped.code,
      message: message && statusCode === 400 ? message : mapped.message,
      details: null,
    });
  }
  if (statusCode >= 400 && statusCode < 500) {
    return new AppError({
      statusCode,
      code: 'BAD_REQUEST',
      message: message ?? 'Bad request.',
      details: null,
    });
  }
  return new AppError({
    statusCode,
    code: 'INTERNAL_ERROR',
    message: 'Unexpected error.',
    details: null,
  });
}

export function toAppError(error: unknown, defaultMessage = 'Invalid request') {
  if (error instanceof AppError) return error;

  if (isAuthError(error)) {
    return AppError.unauthorized('Invalid token');
  }

  if (error instanceof ZodError) {
    const details = error.errors.map((issue) => {
      const field = issue.path.join('.') || 'root';
      const message =
        issue.code === 'invalid_enum_value'
          ? `${field} must be one of ${issue.options.join(', ')}`
          : issue.message;
      return { field, message };
    });

    return AppError.validation(details);
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const pgError = error as PgError;
    if (pgError.code === '23505') {
      const constraint = pgError.constraint;
      let friendlyMessage = 'Resource already exists.';
      if (constraint?.includes('email')) {
        friendlyMessage = 'Email already exists.';
      }
      return AppError.conflict(friendlyMessage);
    }
    if ((pgError as any).code === 'FST_ERR_RATE_LIMIT') {
      return AppError.rateLimited();
    }
  }

  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = Number((error as any).statusCode);
    if (!Number.isNaN(statusCode)) {
      return mapStatusToAppError(statusCode, defaultMessage);
    }
  }

  return AppError.internal();
}

export function respondWithError(
  _reply: FastifyReply,
  error: unknown,
  defaultMessage = 'Invalid request'
): never {
  throw toAppError(error, defaultMessage);
}
