import { EMAIL_STATUS } from '@reachinbox/shared';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { scopedLogger } from '../lib/logger.js';
import { toMessage } from '../lib/errors.js';
import { enqueueIfAbsent } from '../queue/emailQueue.js';

const log = scopedLogger('reconciler');

export interface ReconcileSummary {
  /** Outstanding rows examined. */
  examined: number;
  /** Rows that had no queue job and were re-enqueued for a future time. */
  requeued: number;
  /** Rows whose send time passed while the service was down. */
  caughtUp: number;
  /** Rows that already had a healthy queue job. */
  intact: number;
  /** Abandoned PROCESSING rows handled under the RESEND_SUSPECT_JOBS policy. */
  suspect: number;
  durationMs: number;
}

/**
 * Rebuilds the queue from the database.
 *
 * This is what makes the service survive a restart, and it is why the system
 * needs no cron. Two distinct failure modes are covered:
 *
 *  1. **Process restart.** Redis kept the delayed jobs, so almost everything is
 *     found `intact` and left untouched. Nothing is re-sent.
 *  2. **Redis loss** (flush, eviction, a fresh container). No jobs exist, so
 *     every outstanding row is re-enqueued from its `scheduledAt` column. The
 *     schedule is reconstructed exactly, because the database — not Redis —
 *     was always the source of truth for *when* an email is due.
 *
 * Emails whose time passed while the service was down are sent immediately
 * rather than skipped, still paced by the limiter and the hourly quota.
 */
export async function reconcile(): Promise<ReconcileSummary> {
  const startedAt = Date.now();
  const summary: ReconcileSummary = {
    examined: 0,
    requeued: 0,
    caughtUp: 0,
    intact: 0,
    suspect: 0,
    durationMs: 0,
  };

  const staleBefore = new Date(Date.now() - env.STALE_LOCK_MS);

  // ── Abandoned in-flight work ──────────────────────────────────────────────
  // A row left PROCESSING means a worker died mid-send. We cannot know whether
  // SMTP accepted the message before the crash, so the policy is explicit
  // rather than implicit.
  const abandoned = await prisma.emailJob.findMany({
    where: { status: EMAIL_STATUS.PROCESSING, lockedAt: { lt: staleBefore } },
    select: { id: true, toEmail: true, attempts: true, maxAttempts: true },
  });

  for (const row of abandoned) {
    summary.suspect += 1;

    if (env.RESEND_SUSPECT_JOBS && row.attempts < row.maxAttempts) {
      // Prefer delivery: risk a duplicate rather than a missed email.
      await prisma.emailJob.update({
        where: { id: row.id },
        data: { status: EMAIL_STATUS.SCHEDULED, lockedAt: null, lockedBy: null },
      });
      await prisma.emailEvent.create({
        data: {
          emailJobId: row.id,
          status: EMAIL_STATUS.SCHEDULED,
          message: 'recovered from abandoned PROCESSING state; will retry',
          actor: 'reconciler',
        },
      });
    } else {
      // Prefer safety: never risk sending the same email twice.
      await prisma.emailJob.update({
        where: { id: row.id },
        data: {
          status: EMAIL_STATUS.FAILED,
          lastError:
            'Worker died mid-send; delivery is indeterminate. Not retried because ' +
            'RESEND_SUSPECT_JOBS=false (prefers no-duplicates over guaranteed delivery).',
          lockedAt: null,
          lockedBy: null,
        },
      });
      await prisma.emailEvent.create({
        data: {
          emailJobId: row.id,
          status: EMAIL_STATUS.FAILED,
          message: 'abandoned mid-send, marked indeterminate',
          actor: 'reconciler',
        },
      });
    }
  }

  if (abandoned.length > 0) {
    log.warn(
      { count: abandoned.length, policy: env.RESEND_SUSPECT_JOBS ? 'retry' : 'fail-indeterminate' },
      'handled abandoned in-flight jobs',
    );
  }

  // ── Outstanding scheduled work ────────────────────────────────────────────
  // Paged so a backlog of 100k rows cannot exhaust memory on boot.
  const pageSize = 1000;
  const now = Date.now();
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.emailJob.findMany({
      where: { status: { in: [EMAIL_STATUS.SCHEDULED, EMAIL_STATUS.QUEUED] } },
      select: { id: true, campaignId: true, seq: true, scheduledAt: true },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (page.length === 0) break;

    for (const row of page) {
      summary.examined += 1;

      try {
        const outcome = await enqueueIfAbsent({
          emailJobId: row.id,
          campaignId: row.campaignId,
          seq: row.seq,
          scheduledAt: row.scheduledAt,
        });

        if (outcome === 'exists') {
          summary.intact += 1;
        } else if (row.scheduledAt.getTime() <= now) {
          summary.caughtUp += 1;
        } else {
          summary.requeued += 1;
        }
      } catch (error) {
        log.error({ emailJobId: row.id, err: toMessage(error) }, 'failed to reconcile job');
      }
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < pageSize) break;
  }

  summary.durationMs = Date.now() - startedAt;

  log.info(summary, 'reconciliation complete');
  return summary;
}

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Starts an optional periodic re-run of {@link reconcile}.
 *
 * **This is not the scheduler.** Emails are delivered by BullMQ delayed jobs;
 * this is a self-healing repair loop for drift (a job lost to an eviction, a
 * Redis failover mid-flight). Scheduling is fully functional with
 * `RECONCILE_INTERVAL_MS=0`, which the test suite asserts.
 *
 * It uses `setInterval` — no cron daemon and no cron library, as required.
 */
export function startReconcileSweep(): void {
  if (env.RECONCILE_INTERVAL_MS <= 0) {
    log.info('periodic reconcile sweep disabled (RECONCILE_INTERVAL_MS=0)');
    return;
  }

  sweepTimer = setInterval(() => {
    reconcile().catch((error) => log.error({ err: toMessage(error) }, 'reconcile sweep failed'));
  }, env.RECONCILE_INTERVAL_MS);

  // Must not hold the event loop open during a graceful shutdown.
  sweepTimer.unref();

  log.info({ intervalMs: env.RECONCILE_INTERVAL_MS }, 'periodic reconcile sweep started');
}

export function stopReconcileSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
