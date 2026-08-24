import type { User } from '@prisma/client';

/**
 * Request augmentations set by our own middleware.
 * Declared in one place so handlers get types without per-file casts.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id, set by `requestId` and echoed as `x-request-id`. */
      id: string;
      /** Populated by `requireAuth` / `optionalAuth`. */
      user?: User;
    }
  }
}

export {};
