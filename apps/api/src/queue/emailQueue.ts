import { Queue, type JobsOptions } from 'bullmq';
import { EMAIL_JOB_NAME, EMAIL_QUEUE_NAME } from '@reachinbox/shared';
import { env } from '../config/env.js';
import { scopedLogger } from '../lib/logger.js';
import { getQueueConnection, queuePrefix } from './connection.js';

const log = scopedLogger('queue');

/**
 * The payload carried in Redis.
 *
 * Deliberately minimal: only what the worker needs to *find* the work and pace
 * it. The subject, body and recipient live in Postgres and are read at send
 * time, so editing a campaign can never be contradicted by a stale copy sitting
 * in a delayed job, and Redis stays small when 50k jobs are queued at once.
 */
export interface EmailJobData {
  /** Primary key of the `email_jobs` row. Also the BullMQ `jobId`. */
  emailJobId: string;
  campaignId: string;
  /** Position within the campaign; preserves ordering across window bumps. */
  seq: number;
}

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: getQueueConnection(),
  prefix: queuePrefix,
  defaultJobOptions: {
    attempts: env.MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.RETRY_BACKOFF_MS },
    // Keep a rolling window of completed jobs rather than deleting immediately:
    // BullMQ rejects an `add` whose jobId matches a job it still knows about, so
    // this window is an extra guard against a duplicate enqueue being accepted.
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    // Failures are retained so they can be inspected in Bull Board.
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

/**
 * Builds the options for one email job.
 *
 * `jobId` is the database row id. This is the first of several idempotency
 * layers: BullMQ will not accept a second job with an id it already holds, so a
 * double-submit or a reconciler racing the scheduler cannot create two sends.
 */
export function jobOptionsFor(params: {
  emailJobId: string;
  scheduledAt: Date;
  now?: number;
}): JobsOptions {
  const now = params.now ?? Date.now();
  return {
    jobId: params.emailJobId,
    delay: Math.max(0, params.scheduledAt.getTime() - now),
  };
}

/**
 * Enqueues many emails at once.
 *
 * Chunked because `addBulk` builds a single Redis pipeline: 50k jobs in one
 * call produces a multi-megabyte command that stalls the event loop and can
 * exceed Redis' proto-max-bulk-len. 500 keeps each round-trip small while still
 * amortising latency.
 */
export async function enqueueEmailJobs(
  jobs: Array<{ emailJobId: string; campaignId: string; seq: number; scheduledAt: Date }>,
  chunkSize = 500,
): Promise<number> {
  const now = Date.now();
  let added = 0;

  for (let index = 0; index < jobs.length; index += chunkSize) {
    const chunk = jobs.slice(index, index + chunkSize);

    const results = await emailQueue.addBulk(
      chunk.map((job) => ({
        name: EMAIL_JOB_NAME,
        data: { emailJobId: job.emailJobId, campaignId: job.campaignId, seq: job.seq },
        opts: jobOptionsFor({ emailJobId: job.emailJobId, scheduledAt: job.scheduledAt, now }),
      })),
    );

    added += results.length;
  }

  log.info({ requested: jobs.length, added }, 'enqueued email jobs');
  return added;
}

/**
 * Adds a single job unless one already exists for that row.
 *
 * Used by the reconciler on boot. `getJob` is checked first so a job that is
 * mid-flight (active, or already delayed with the right timestamp) is left
 * strictly alone rather than being disturbed.
 */
export async function enqueueIfAbsent(params: {
  emailJobId: string;
  campaignId: string;
  seq: number;
  scheduledAt: Date;
}): Promise<'added' | 'exists'> {
  const existing = await emailQueue.getJob(params.emailJobId);
  if (existing) return 'exists';

  await emailQueue.add(
    EMAIL_JOB_NAME,
    { emailJobId: params.emailJobId, campaignId: params.campaignId, seq: params.seq },
    jobOptionsFor(params),
  );
  return 'added';
}

/** Removes a job from the queue — used when a scheduled email is cancelled. */
export async function removeEmailJob(emailJobId: string): Promise<boolean> {
  const job = await emailQueue.getJob(emailJobId);
  if (!job) return false;

  try {
    await job.remove();
    return true;
  } catch (error) {
    // An active job cannot be removed; the worker's status check will see the
    // CANCELLED row and skip the send instead.
    log.warn({ emailJobId, err: (error as Error).message }, 'could not remove active job');
    return false;
  }
}

export async function queueDepth(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}> {
  const counts = await emailQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}

export async function closeQueue(): Promise<void> {
  await emailQueue.close();
}
