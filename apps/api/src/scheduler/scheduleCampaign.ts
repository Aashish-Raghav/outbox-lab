import {
  CAMPAIGN_STATUS,
  EMAIL_STATUS,
  projectCampaign,
  scheduledAtForSeq,
} from '@reachinbox/shared';
import type { Campaign } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { scopedLogger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { enqueueEmailJobs } from '../queue/emailQueue.js';
import { resolveSenderLimit } from '../ratelimit/rateLimiter.js';
import { htmlToText, sanitizeBody } from '../mail/sendEmail.js';

const log = scopedLogger('scheduler');

export interface ScheduleCampaignParams {
  userId: string;
  senderId: string;
  subject: string;
  bodyHtml: string;
  /** Already parsed, validated and de-duplicated. */
  recipients: string[];
  startAt?: Date;
  delayBetweenMs: number;
  /** 0 => inherit the sender/deployment default. */
  hourlyLimit: number;
  attachments?: Array<{ filename: string; mimeType: string; size: number; storagePath: string }>;
}

export interface ScheduleCampaignResult {
  campaign: Campaign;
  enqueued: number;
  projectedCompletionAt: Date;
  windowsRequired: number;
  throttledByHourlyLimit: boolean;
}

/**
 * Persists a campaign and schedules every one of its emails.
 *
 * The critical ordering property: **the database is written first, and only
 * then is Redis told about the work.** If the process dies between the two, the
 * rows still exist as SCHEDULED and the reconciler will enqueue them on the
 * next boot. The reverse order would lose the emails entirely if the DB write
 * failed after the jobs were queued.
 */
export async function scheduleCampaign(
  params: ScheduleCampaignParams,
): Promise<ScheduleCampaignResult> {
  const {
    userId,
    senderId,
    subject,
    recipients,
    delayBetweenMs,
    hourlyLimit,
    attachments = [],
  } = params;

  if (recipients.length === 0) {
    throw new ValidationError('At least one valid recipient is required', {
      recipients: ['No valid email addresses were found in the list.'],
    });
  }

  if (recipients.length > env.MAX_RECIPIENTS_PER_CAMPAIGN) {
    throw new ValidationError(
      `A campaign is limited to ${env.MAX_RECIPIENTS_PER_CAMPAIGN} recipients`,
      { recipients: [`Received ${recipients.length}.`] },
    );
  }

  const sender = await prisma.sender.findUnique({ where: { id: senderId } });
  if (!sender) throw new NotFoundError('Sender');
  if (!sender.isActive) throw new ValidationError('That sender is disabled');

  // Sanitised once, at write time, so every consumer (the worker, the detail
  // view, the plain-text alternative) reads the same trusted content.
  const bodyHtml = sanitizeBody(params.bodyHtml);
  if (htmlToText(bodyHtml).trim() === '' && !bodyHtml.includes('<img')) {
    throw new ValidationError('Body is required', { bodyHtml: ['The message body is empty.'] });
  }

  // A start time in the past means "send now" rather than an error — the user
  // may simply have taken a moment to hit the button.
  const startAt = params.startAt && params.startAt.getTime() > Date.now() ? params.startAt : new Date();

  const effectiveHourlyLimit = resolveSenderLimit({
    campaignHourlyLimit: hourlyLimit > 0 ? hourlyLimit : null,
    senderMaxPerHour: sender.maxEmailsPerHour,
  });

  const projection = projectCampaign({
    startAt: startAt.getTime(),
    recipientCount: recipients.length,
    delayBetweenMs,
    hourlyLimit: effectiveHourlyLimit,
  });

  // ── 1. Durable write ──────────────────────────────────────────────────────
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        userId,
        senderId,
        subject,
        bodyHtml,
        startAt,
        delayBetweenMs,
        hourlyLimit: hourlyLimit > 0 ? hourlyLimit : null,
        totalRecipients: recipients.length,
        status: CAMPAIGN_STATUS.SCHEDULED,
        ...(attachments.length > 0 ? { attachments: { create: attachments } } : {}),
      },
    });

    // `createMany` in one statement: inserting 1000 rows individually would be
    // 1000 round-trips and would hold the transaction open far too long.
    await tx.emailJob.createMany({
      data: recipients.map((toEmail, seq) => ({
        campaignId: created.id,
        userId,
        senderId,
        toEmail,
        subject,
        bodyHtml,
        seq,
        // The cadence is materialised per row, so it survives a restart
        // instead of living only in a worker's memory.
        scheduledAt: new Date(scheduledAtForSeq(startAt.getTime(), seq, delayBetweenMs)),
        status: EMAIL_STATUS.SCHEDULED,
        maxAttempts: env.MAX_ATTEMPTS,
      })),
      skipDuplicates: true,
    });

    return created;
  });

  // ── 2. Index the work in Redis ────────────────────────────────────────────
  const rows = await prisma.emailJob.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, seq: true, scheduledAt: true },
    orderBy: { seq: 'asc' },
  });

  const enqueued = await enqueueEmailJobs(
    rows.map((row) => ({
      emailJobId: row.id,
      campaignId: campaign.id,
      seq: row.seq,
      scheduledAt: row.scheduledAt,
    })),
  );

  log.info(
    {
      campaignId: campaign.id,
      recipients: recipients.length,
      enqueued,
      startAt: startAt.toISOString(),
      delayBetweenMs,
      effectiveHourlyLimit,
      windowsRequired: projection.windowsRequired,
    },
    'campaign scheduled',
  );

  return {
    campaign,
    enqueued,
    projectedCompletionAt: new Date(projection.completesAt),
    windowsRequired: projection.windowsRequired,
    throttledByHourlyLimit: projection.throttledByHourlyLimit,
  };
}
