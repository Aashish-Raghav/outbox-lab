/**
 * Application error taxonomy.
 *
 * Route handlers throw these; the central error middleware is the only place
 * that knows how to turn one into an HTTP response. That keeps status codes and
 * the response envelope consistent across every endpoint.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;
  /** Expected errors are logged at warn; unexpected ones at error with a stack. */
  readonly expected: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      details?: Record<string, string[]>;
      expected?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;
    this.expected = options.expected ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: Record<string, string[]>) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { statusCode: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 409, code: 'CONFLICT' });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
}

/**
 * Raised by the worker when a send cannot proceed right now but must not be
 * treated as a failure — the job is rescheduled instead of consuming a retry.
 */
export class RateLimitedError extends AppError {
  readonly retryAtMs: number;
  readonly scope: 'global' | 'sender';

  constructor(scope: 'global' | 'sender', retryAtMs: number) {
    super(`Hourly send quota reached for ${scope}`, {
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
    this.retryAtMs = retryAtMs;
    this.scope = scope;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Narrows an unknown thrown value to a readable message. */
export function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
