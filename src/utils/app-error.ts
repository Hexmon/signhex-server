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

  static unauthorized(message = 'Unauthorized.', details?: ErrorDetails) {
    return new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message, details });
  }

  static forbidden(message = 'Forbidden.', details?: ErrorDetails) {
    return new AppError({ statusCode: 403, code: 'FORBIDDEN', message, details });
  }

  static notFound(message = 'Not found.', details?: ErrorDetails) {
    return new AppError({ statusCode: 404, code: 'NOT_FOUND', message, details });
  }

  static conflict(message = 'Conflict.', details?: ErrorDetails) {
    return new AppError({ statusCode: 409, code: 'CONFLICT', message, details });
  }

  static rateLimited(message = 'Too many requests. Please try again later.', details?: ErrorDetails) {
    return new AppError({ statusCode: 429, code: 'RATE_LIMITED', message, details });
  }

  static internal(message = 'Unexpected error.', details?: ErrorDetails) {
    return new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message, details });
  }

  static caCertMissing(message = 'CA certificate is missing. Please configure CA_CERT_PATH correctly.') {
    return new AppError({
      statusCode: 500,
      code: 'CA_CERT_MISSING',
      message,
      details: null,
    });
  }

  static caKeyMissing(message = 'CA private key is missing. Please configure CA_KEY_PATH correctly.') {
    return new AppError({
      statusCode: 500,
      code: 'CA_KEY_MISSING',
      message,
      details: null,
    });
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
