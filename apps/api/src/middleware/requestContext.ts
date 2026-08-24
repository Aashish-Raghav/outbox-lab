import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger.js';

/**
 * Tags every request with an id, echoes it back in a header, and attaches it to
 * the log line and any error envelope. Turns "it failed for a user once" into
 * something that can actually be traced through the logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID();

  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).id ?? randomUUID(),
  // Health checks would otherwise dominate the log at info level.
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/health/live',
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
