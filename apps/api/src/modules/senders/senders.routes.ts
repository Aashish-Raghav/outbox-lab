import { Router } from 'express';
import { nextHourWindowStart, type SenderQuota } from '@reachinbox/shared';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { hourlyQuota, resolveSenderLimit } from '../../ratelimit/rateLimiter.js';

export const sendersRouter: Router = Router();

sendersRouter.use(requireAuth);

/**
 * Populates the Compose screen's `From` dropdown.
 *
 * Each sender reports its live quota for the current hour window, so the user
 * can see *before* scheduling that a mailbox is nearly capped — and understand
 * why a large batch will spill into later hours.
 *
 * SMTP credentials are deliberately absent from the response.
 */
sendersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const senders = await prisma.sender.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        fromEmail: true,
        isActive: true,
        maxEmailsPerHour: true,
      },
    });

    const now = Date.now();
    const windowResetsAt = new Date(nextHourWindowStart(now)).toISOString();

    const data: SenderQuota[] = await Promise.all(
      senders.map(async (sender) => {
        const limitThisHour = resolveSenderLimit({ senderMaxPerHour: sender.maxEmailsPerHour });
        const usage = await hourlyQuota.usage(sender.id, now);

        return {
          ...sender,
          usedThisHour: usage.sender,
          limitThisHour,
          globalUsedThisHour: usage.global,
          globalLimitThisHour: env.MAX_EMAILS_PER_HOUR,
          windowResetsAt,
        };
      }),
    );

    res.json({ data });
  }),
);
