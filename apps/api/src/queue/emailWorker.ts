import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  EMAIL_QUEUE_NAME,
  EMAIL_STATUS,
  rescheduleTarget,
  type EmailStatus,
} from '@reachinbox/shared';
import type { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { scopedLogger } from '../lib/logger.js';
import { toMessage } from '../lib/errors.js';
import { sendEmail } from '../mail/sendEmail.js';
import { hourlyQuota, resolveSenderLimit } from '../ratelimit/rateLimiter.js';
import { createWorkerConnection, queuePrefix } from './connection.js';
import type { EmailJobData } from './emailQueue.js';

const log = scopedLogger('worker');

/** Identifies this process in lock rows and the audit trail. */
export const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** Appends to the audit trail. Never allowed to break a send. */
async function recordEvent(
  emailJobId: string,
  status: EmailStatus,
  message?: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  try {
    await tx.emailEvent.create({
      data: { emailJobId, status, message: message ?? null, actor: WORKER_ID },
    });
  } catch (error) {
    log.warn({ emailJobId, err: toMessage(error) }, 'failed to write audit event');
  }
}

/**
 * Atomically claims a job for this worker.
 *
 * This is the idempotency guard that actually matters under concurrency. The
 * `WHERE status IN (SCHEDULED, QUEUED)` predicate is evaluated by Postgres as
 * part of the UPDATE, so exactly one of N racing workers can transition the row
 * to PROCESSING — the losers see `count: 0` and stand down without sending.
 *
 * A plain read-then-write would leave a window between the check and the write
 * in which both workers believe they own the job.
 */
async function claim(emailJobId: string): Promise<boolean> {
  const { count } = await prisma.emailJob.updateMany({
    where: {
      id: emailJobId,
      status: { in: [EMAIL_STATUS.SCHEDULED, EMAIL_STATUS.QUEUED] },
    },
    data: {
      status: EMAIL_STATUS.PROCESSING,
      attempts: { increment: 1 },
      lockedAt: new Date(),
      lockedBy: WORKER_ID,
    },
  });

  return count === 1;
}

/** Releases a claim back to SCHEDULED without consuming a delivery attempt. */
async function release(emailJobId: string, scheduledAt: Date): Promise<void> {
  await prisma.emailJob.updateMany({
    where: { id: emailJobId, status: EMAIL_STATUS.PROCESSING, lockedBy: WORKER_ID },
    data: {
      status: EMAIL_STATUS.SCHEDULED,
      scheduledAt,
      lockedAt: null,
      lockedBy: null,
      // The attempt counter is walked back: being throttled is not a failure,
      // and must not burn one of the job's retries.
      attempts: { decrement: 1 },
    },
  });
}

/**
 * Picks a fallback sender that still has quota, when the assigned one is full.
 *
 * Off by default. It trades strict "this campaign sends from this address" for
 * throughput, which is not always the right call for cold outreach where the
 * From address is part of the campaign's identity.
 */
async function findAlternativeSender(
  excludeSenderId: string,
  campaignHourlyLimit: number | null,
): Promise<{ id: string; limit: number } | null> {
  const candidates = await prisma.sender.findMany({
    where: { isActive: true, id: { not: excludeSenderId } },
  });

  for (const candidate of candidates) {
    const limit = resolveSenderLimit({
      campaignHourlyLimit,
      senderMaxPerHour: candidate.maxEmailsPerHour,
    });
    const { sender: used } = await hourlyQuota.usage(candidate.id);
    if (used < limit) return { id: candidate.id, limit };
  }

  return null;
}

/**
 * Processes one email.
 *
 * Ordering is deliberate:
 *   1. load + validate the row is still sendable
 *   2. claim it atomically (only one worker proceeds)
 *   3. reserve hourly quota (Redis, atomic across processes)
 *   4. hand off to SMTP
 *   5. record the terminal state
 *
 * Quota is reserved *before* the SMTP call so a crash can only under-use the
 * allowance, never exceed the provider's real limit.
 */
async function processEmail(job: Job<EmailJobData>, token?: string): Promise<{ status: string }> {
  const { emailJobId } = job.data;

  const row = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: { sender: true, campaign: { include: { attachments: true } } },
  });

  if (!row) {
    // The campaign was deleted after the job was queued. Nothing to do, and
    // retrying will never help.
    log.warn({ emailJobId }, 'no database row for queued job, discarding');
    throw new UnrecoverableError(`email_jobs row ${emailJobId} no longer exists`);
  }

  // ── Idempotency layer: terminal states are never re-sent ──────────────────
  // Covers a BullMQ retry that fires after the send already succeeded (e.g. the
  // process died between SMTP acceptance and the completion acknowledgement).
  if (row.status === EMAIL_STATUS.SENT) {
    log.info({ emailJobId }, 'already sent, skipping duplicate delivery');
    return { status: 'already-sent' };
  }
  if (row.status === EMAIL_STATUS.CANCELLED) {
    return { status: 'cancelled' };
  }
  if (row.status === EMAIL_STATUS.FAILED && row.attempts >= row.maxAttempts) {
    return { status: 'already-failed' };
  }

  // ── Idempotency layer: exclusive claim ────────────────────────────────────
  if (!(await claim(emailJobId))) {
    log.info({ emailJobId, status: row.status }, 'lost claim race, another worker owns this job');
    return { status: 'not-claimed' };
  }

  // Records who won the claim and when the send actually began. This is the
  // timestamp that reflects send *pacing*: `sentAt` is written after the SMTP
  // round-trip, so it also carries connection and delivery latency.
  await recordEvent(emailJobId, EMAIL_STATUS.PROCESSING, 'claimed for delivery');

  const campaignLimit = row.campaign.hourlyLimit;
  let senderId = row.senderId;
  let sender = row.sender;
  let senderLimit = resolveSenderLimit({
    campaignHourlyLimit: campaignLimit,
    senderMaxPerHour: sender.maxEmailsPerHour,
  });

  // ── Hourly quota ──────────────────────────────────────────────────────────
  let decision = await hourlyQuota.reserve({ senderId, senderLimit });

  if (!decision.allowed && decision.scope === 'sender' && env.SENDER_FAILOVER) {
    const alternative = await findAlternativeSender(senderId, campaignLimit);
    if (alternative) {
      const retry = await hourlyQuota.reserve({
        senderId: alternative.id,
        senderLimit: alternative.limit,
      });
      if (retry.allowed) {
        log.info({ emailJobId, from: senderId, to: alternative.id }, 'failed over to another sender');
        senderId = alternative.id;
        senderLimit = alternative.limit;
        sender = (await prisma.sender.findUniqueOrThrow({ where: { id: alternative.id } }));
        decision = retry;
      }
    }
  }

  if (!decision.allowed) {
    return deferToNextWindow(job, row, decision.scope, decision.retryAfterMs, token);
  }

  const reservedAt = Date.now();

  // ── Delivery ──────────────────────────────────────────────────────────────
  try {
    const result = await sendEmail({
      sender,
      to: row.toEmail,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      attachments: row.campaign.attachments,
      messageIdSeed: row.id,
    });

    // An address the SMTP server explicitly refused will never succeed on a
    // retry, so it is failed terminally rather than burning attempts.
    if (result.rejected.length > 0 && result.accepted.length === 0) {
      await markFailed(emailJobId, `SMTP rejected recipient: ${result.rejected.join(', ')}`, true);
      throw new UnrecoverableError(`Recipient rejected: ${row.toEmail}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.emailJob.update({
        where: { id: emailJobId },
        data: {
          status: EMAIL_STATUS.SENT,
          sentAt: new Date(),
          senderId,
          messageId: result.messageId,
          previewUrl: result.previewUrl,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
        },
      });
      await recordEvent(emailJobId, EMAIL_STATUS.SENT, result.previewUrl ?? result.messageId, tx);
    });

    log.info(
      { emailJobId, to: row.toEmail, senderId, previewUrl: result.previewUrl },
      'email sent',
    );

    return { status: 'sent' };
  } catch (error) {
    if (error instanceof UnrecoverableError) throw error;

    const message = toMessage(error);

    if (env.RATE_LIMIT_REFUND_ON_FAILURE) {
      await hourlyQuota.refund(senderId, reservedAt);
    }

    const willRetry = row.attempts < row.maxAttempts;

    if (willRetry) {
      // Hand the row back so a retry can re-claim it. BullMQ's own backoff
      // governs when that happens.
      await prisma.$transaction(async (tx) => {
        await tx.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: EMAIL_STATUS.SCHEDULED,
            lastError: message,
            lockedAt: null,
            lockedBy: null,
          },
        });
        await recordEvent(emailJobId, EMAIL_STATUS.SCHEDULED, `retry after error: ${message}`, tx);
      });
      log.warn({ emailJobId, attempt: row.attempts, err: message }, 'send failed, will retry');
    } else {
      await markFailed(emailJobId, message, false);
      log.error({ emailJobId, err: message }, 'send failed permanently');
    }

    throw error;
  }
}

async function markFailed(emailJobId: string, message: string, terminal: boolean): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.emailJob.update({
      where: { id: emailJobId },
      data: {
        status: EMAIL_STATUS.FAILED,
        lastError: message,
        lockedAt: null,
        lockedBy: null,
      },
    });
    await recordEvent(
      emailJobId,
      EMAIL_STATUS.FAILED,
      terminal ? `permanent: ${message}` : message,
      tx,
    );
  });
}

/**
 * Pushes a throttled job into the next hour window.
 *
 * The requirement is explicit that hitting the cap must not drop or fail work.
 * So the job is *moved*, not failed: the row returns to SCHEDULED with a new
 * `scheduledAt`, the BullMQ job is re-delayed to the same instant, and the
 * attempt counter is rolled back.
 *
 * `seq` is folded into the target time so a deferred batch keeps its original
 * relative ordering instead of all landing on the same millisecond.
 */
async function deferToNextWindow(
  job: Job<EmailJobData>,
  row: { id: string; seq: number; rescheduleCount: number },
  scope: 'global' | 'sender',
  retryAfterMs: number,
  token?: string,
): Promise<never> {
  const now = Date.now();

  // A job that keeps losing the race for quota would otherwise bounce forever.
  if (row.rescheduleCount >= env.MAX_RESCHEDULES) {
    await markFailed(
      row.id,
      `Exceeded MAX_RESCHEDULES (${env.MAX_RESCHEDULES}) waiting for ${scope} quota`,
      true,
    );
    throw new UnrecoverableError(`Job ${row.id} exhausted its reschedule budget`);
  }

  // Derived purely from (window, seq), never from elapsed time. An earlier
  // version took `max(now + retryAfterMs, ...)`, but `retryAfterMs` is measured
  // inside `reserve()` a few milliseconds before this line runs, so each
  // concurrently-deferred job picked up a slightly different drift and the batch
  // came out of the next window in a scrambled order.
  const targetMs = rescheduleTarget({
    now,
    seq: row.seq,
    minDelayMs: env.MIN_DELAY_BETWEEN_SENDS_MS,
  });
  const target = new Date(targetMs);

  await release(row.id, target);
  await prisma.emailJob.update({
    where: { id: row.id },
    data: { rescheduleCount: { increment: 1 } },
  });
  await recordEvent(
    row.id,
    EMAIL_STATUS.SCHEDULED,
    `${scope} hourly quota reached; deferred to ${target.toISOString()}`,
  );

  log.info(
    { emailJobId: row.id, scope, target: target.toISOString(), seq: row.seq, retryAfterMs },
    'hourly quota reached, deferred to next window',
  );

  // `moveToDelayed` + DelayedError is BullMQ's supported way to postpone a job
  // from inside the processor without it counting as a failure.
  await job.moveToDelayed(targetMs, token);
  throw new DelayedError();
}

export function createEmailWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmail, {
    connection: createWorkerConnection(),
    prefix: queuePrefix,
    concurrency: env.WORKER_CONCURRENCY,

    // Minimum spacing between individual sends, to mimic provider throttling.
    // BullMQ's limiter is Redis-backed, so this holds across *every* worker
    // process, not just this one — an in-process timer would not.
    limiter:
      env.MIN_DELAY_BETWEEN_SENDS_MS > 0
        ? { max: 1, duration: env.MIN_DELAY_BETWEEN_SENDS_MS }
        : undefined,

    // How long a job may run before BullMQ considers the worker dead and lets
    // the job be picked up again. The DB claim makes that recovery safe.
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });

  worker.on('failed', (job, error) => {
    if (error instanceof DelayedError) return; // deferred, not failed
    log.warn({ emailJobId: job?.data.emailJobId, err: error.message }, 'job failed');
  });

  worker.on('error', (error) => {
    log.error({ err: error.message }, 'worker error');
  });

  log.info(
    {
      workerId: WORKER_ID,
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_BETWEEN_SENDS_MS,
      maxPerHour: env.MAX_EMAILS_PER_HOUR,
      maxPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    },
    'email worker started',
  );

  return worker;
}
