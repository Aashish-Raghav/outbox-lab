import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { AppError, isAppError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Flattens a ZodError into `{ "field.path": ["message"] }`. */
function zodDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/**
 * Translates anything thrown in a route into the API's single error envelope.
 *
 * Centralised so status codes stay consistent, and so an unexpected exception
 * can never leak a stack trace or a SQL fragment to the client in production.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: Record<string, string[]> | undefined;
  let expected = false;

  if (error instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = zodDetails(error);
    expected = true;
  } else if (isAppError(error)) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
    details = error.details;
    expected = error.expected;
  } else if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = error.code;
    message =
      error.code === 'LIMIT_FILE_SIZE' ? 'The uploaded file is too large' : error.message;
    expected = true;
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    expected = true;
    if (error.code === 'P2002') {
      status = 409;
      code = 'CONFLICT';
      message = 'That record already exists';
    } else if (error.code === 'P2025') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'Record not found';
    } else {
      status = 400;
      code = `DB_${error.code}`;
      message = 'The database rejected that request';
    }
  }

  const log = req.log ?? logger;
  if (expected) {
    log.warn({ code, status, err: (error as Error)?.message }, 'request failed');
  } else {
    log.error({ code, status, err: error }, 'unhandled error');
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId: req.id,
      // A stack is invaluable in development and a liability in production.
      ...(!isProduction && !expected && error instanceof Error ? { stack: error.stack } : {}),
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
}

/**
 * Wraps an async handler so a rejected promise reaches `errorHandler`.
 * Express 4 does not do this itself — without it, a throw in an async route
 * hangs the request until it times out.
 */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  handler: T,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

export { AppError };
