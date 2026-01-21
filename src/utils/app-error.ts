export type ErrorDetails =
  | Array<{ field: string; message: string }>
  | Record<string, unknown>
  | null;

export type AppErrorArgs = {
  statusCode: number;
  code: string;
  message: string;
  details?: ErrorDetails;
};

export class AppError extends Error {
  statusCode: number;
  code: string;
  details: ErrorDetails;

  constructor({ statusCode, code, message, details }: AppErrorArgs) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? null;
  }

  static badRequest(message = 'Bad request.', details?: ErrorDetails) {
    return new AppError({ statusCode: 400, code: 'BAD_REQUEST', message, details });
  }

  static validation(details?: ErrorDetails) {
    return new AppError({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Some fields are invalid.',
      details,
    });
  }

  static unauthorized(message = 'Unauthorized.') {
    return new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message, details: null });
  }

  static forbidden(message = 'Forbidden.') {
    return new AppError({ statusCode: 403, code: 'FORBIDDEN', message, details: null });
  }

  static notFound(message = 'Not found.') {
    return new AppError({ statusCode: 404, code: 'NOT_FOUND', message, details: null });
  }

  static conflict(message = 'Conflict.') {
    return new AppError({ statusCode: 409, code: 'CONFLICT', message, details: null });
  }

  static rateLimited(message = 'Too many requests. Please try again later.') {
    return new AppError({ statusCode: 429, code: 'RATE_LIMITED', message, details: null });
  }

  static internal(message = 'Unexpected error.') {
    return new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message, details: null });
  }
}

export type ErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
    details: ErrorDetails;
    traceId: string | null;
  };
};

export function formatErrorResponse(appError: AppError, traceId?: string | null): ErrorResponse {
  return {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details ?? null,
      traceId: traceId ?? null,
    },
  };
}
