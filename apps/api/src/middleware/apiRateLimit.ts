import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env.js';

/**
 * HTTP-level abuse protection.
 *
 * Unrelated to the *email* hourly quota — this guards the API surface itself.
 * Disabled under test so the suite can hammer endpoints without tripping it.
 */

const shared = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  skip: () => isTest,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please slow down.' },
  },
};

/** Broad ceiling for the whole API. */
export const generalLimiter = rateLimit({ windowMs: 60_000, limit: 300, ...shared });

/** Login is the classic credential-stuffing target, so it is much tighter. */
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, ...shared });

/** Campaign creation is expensive: it can insert tens of thousands of rows. */
export const campaignLimiter = rateLimit({ windowMs: 60_000, limit: 20, ...shared });
