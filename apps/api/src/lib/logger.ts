import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Structured logging. Pretty-printed in development for readability, JSON in
 * production so it can be shipped to a log aggregator.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.smtpPass',
      '*.password',
      '*.credential',
    ],
    censor: '[redacted]',
  },
});

/** Child logger tagged with a subsystem, so queue noise is easy to filter. */
export function scopedLogger(scope: string) {
  return logger.child({ scope });
}
