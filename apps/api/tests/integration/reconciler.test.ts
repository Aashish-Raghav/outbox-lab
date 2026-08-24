import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_STATUS } from '@reachinbox/shared';
import { env } from '../../src/config/env.js';
import { prisma, disconnectDatabase } from '../../src/lib/prisma.js';
import { disconnectRedis } from '../../src/lib/redis.js';
import { emailQueue, closeQueue } from '../../src/queue/emailQueue.js';
import { reconcile, startReconcileSweep, stopReconcileSweep } from '../../src/scheduler/reconciler.js';
import { scheduleCampaign } from '../../src/scheduler/scheduleCampaign.js';
import { createSender, createUser, resetAll, resetRedis } from '../helpers.js';

/**
 * "Emails scheduled for the future must still be sent after a restart, and
 * nothing may be re-sent or lost."
 *
 * Two failure modes are distinct and both are covered here:
 *
 *  - a **process restart**, where Redis kept its delayed jobs — the reconciler
 *    must find them intact and change nothing;
 *  - **Redis loss**, where the queue is gone — the reconciler must rebuild the
 *    entire schedule from the `scheduledAt` column, which is why the database,
 *    not Redis, is the source of truth for when an email is due.
 */

const ONE_HOUR = 60 * 60 * 1000;

beforeEach(resetAll);

afterAll(async () => {
  stopReconcileSweep();
  await resetAll();
  await closeQueue();
  await disconnectDatabase();
  await disconnectRedis();
});

async function scheduleBatch(count: number, startAt: Date) {
  const user = await createUser();
  const sender = await createSender();

  const { campaign } = await scheduleCampaign({
    userId: user.id,
    senderId: sender.id,
    subject: 'Restart survival',
    bodyHtml: '<p>hello</p>',
    recipients: Array.from({ length: count }, (_, i) => `r${i}@example.com`),
    startAt,
    delayBetweenMs: 60_000,
    hourlyLimit: 0,
  });

  return { user, sender, campaign };
}

describe('reconcile — process restart (Redis intact)', () => {
  it('leaves healthy delayed jobs untouched', async () => {
    const startAt = new Date(Date.now() + ONE_HOUR);
    await scheduleBatch(5, startAt);

    const summary = await reconcile();

    expect(summary.examined).toBe(5);
    expect(summary.intact).toBe(5);
    expect(summary.requeued).toBe(0);
    expect(summary.caughtUp).toBe(0);

    // Crucially, no second copy of any job was created.
    const counts = await emailQueue.getJobCounts('delayed', 'waiting', 'active');
    expect(counts.delayed).toBe(5);
  });

  it('is safe to run repeatedly', async () => {
    await scheduleBatch(3, new Date(Date.now() + ONE_HOUR));

    // The periodic sweep re-runs this indefinitely; a duplicate on any pass
    // would eventually mean a duplicate send.
    for (let i = 0; i < 3; i += 1) {
      const summary = await reconcile();
      expect(summary.intact).toBe(3);
    }

    const counts = await emailQueue.getJobCounts('delayed');
    expect(counts.delayed).toBe(3);
  });

  it('ignores rows that already reached a terminal state', async () => {
    const { campaign } = await scheduleBatch(4, new Date(Date.now() + ONE_HOUR));
    const rows = await prisma.emailJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { seq: 'asc' },
    });

    await prisma.emailJob.update({
      where: { id: rows[0]!.id },
      data: { status: EMAIL_STATUS.SENT, sentAt: new Date() },
    });
    await prisma.emailJob.update({
      where: { id: rows[1]!.id },
      data: { status: EMAIL_STATUS.CANCELLED },
    });
    await prisma.emailJob.update({
      where: { id: rows[2]!.id },
      data: { status: EMAIL_STATUS.FAILED, lastError: 'nope' },
    });

    const summary = await reconcile();

    // Only the one still-outstanding row is the reconciler's business.
    expect(summary.examined).toBe(1);
  });
});

describe('reconcile — Redis loss', () => {
  /**
   * The headline test. Every queue key is deleted mid-flight, exactly as if
   * Redis had been flushed or replaced with an empty container.
   */
  it('rebuilds the whole schedule from the database', async () => {
    const startAt = new Date(Date.now() + ONE_HOUR);
    const { campaign } = await scheduleBatch(10, startAt);

    await resetRedis();
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(0);

    const summary = await reconcile();

    expect(summary.examined).toBe(10);
    expect(summary.requeued).toBe(10);
    expect(summary.intact).toBe(0);
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(10);

    // Not merely re-queued — re-queued for the *original* instants, so the
    // campaign's cadence is reconstructed rather than restarted.
    const rows = await prisma.emailJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { seq: 'asc' },
    });

    for (const row of rows) {
      const job = await emailQueue.getJob(row.id);
      expect(job).toBeTruthy();

      const firesAt = Date.now() + (job!.opts.delay ?? 0);
      // A second of slack for the round-trips the reconciler itself made.
      expect(Math.abs(firesAt - row.scheduledAt.getTime())).toBeLessThan(1000);
    }
  });

  it('keeps the job id equal to the row id, so a rebuild cannot duplicate', async () => {
    const { campaign } = await scheduleBatch(3, new Date(Date.now() + ONE_HOUR));
    await resetRedis();

    // Two reconcilers racing on boot (API and worker process) must converge.
    await Promise.all([reconcile(), reconcile()]);

    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(3);

    const rows = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });
    for (const row of rows) {
      expect(await emailQueue.getJob(row.id)).toBeTruthy();
    }
  });

  it('sends emails whose time passed while the service was down', async () => {
    const { campaign } = await scheduleBatch(3, new Date(Date.now() + ONE_HOUR));

    // Rewind the schedule to simulate an outage that outlasted the send time.
    await prisma.emailJob.updateMany({
      where: { campaignId: campaign.id },
      data: { scheduledAt: new Date(Date.now() - 10 * 60_000) },
    });
    await resetRedis();

    const summary = await reconcile();

    // Caught up rather than skipped: a missed window must not silently drop
    // the email. Pacing is still applied downstream by the quota and limiter.
    expect(summary.caughtUp).toBe(3);
    expect(summary.requeued).toBe(0);

    const counts = await emailQueue.getJobCounts('waiting', 'delayed', 'active');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0)).toBe(3);
  });
});

describe('reconcile — abandoned in-flight work', () => {
  it('does not touch a claim that is still fresh', async () => {
    const { campaign } = await scheduleBatch(1, new Date(Date.now() + ONE_HOUR));
    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });

    await prisma.emailJob.update({
      where: { id: row.id },
      data: { status: EMAIL_STATUS.PROCESSING, lockedAt: new Date(), lockedBy: 'live-worker' },
    });

    const summary = await reconcile();

    // A worker mid-SMTP-handshake must not have its job stolen.
    expect(summary.suspect).toBe(0);
    expect((await prisma.emailJob.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      EMAIL_STATUS.PROCESSING,
    );
  });

  it('marks a stale claim indeterminate rather than risking a duplicate', async () => {
    const { campaign } = await scheduleBatch(1, new Date(Date.now() + ONE_HOUR));
    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });

    await prisma.emailJob.update({
      where: { id: row.id },
      data: {
        status: EMAIL_STATUS.PROCESSING,
        lockedAt: new Date(Date.now() - env.STALE_LOCK_MS - 60_000),
        lockedBy: 'dead-worker',
      },
    });

    const summary = await reconcile();
    expect(summary.suspect).toBe(1);

    const after = await prisma.emailJob.findUniqueOrThrow({ where: { id: row.id } });
    // RESEND_SUSPECT_JOBS defaults to false: we cannot know whether SMTP
    // accepted the message before the crash, so we prefer no duplicate over
    // guaranteed delivery. The reason is written down for the operator.
    expect(after.status).toBe(EMAIL_STATUS.FAILED);
    expect(after.lastError).toMatch(/indeterminate/i);
    expect(after.lockedBy).toBeNull();

    const events = await prisma.emailEvent.findMany({ where: { emailJobId: row.id } });
    expect(events.some((event) => event.actor === 'reconciler')).toBe(true);
  });
});

describe('the periodic sweep is not the scheduler', () => {
  it('is disabled by RECONCILE_INTERVAL_MS=0 and scheduling still works', async () => {
    // The suite runs with RECONCILE_INTERVAL_MS=0 throughout, so every other
    // test in this file already proves scheduling does not depend on the sweep.
    expect(env.RECONCILE_INTERVAL_MS).toBe(0);

    startReconcileSweep();
    const { campaign } = await scheduleBatch(2, new Date(Date.now() + ONE_HOUR));

    const rows = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });
    for (const row of rows) {
      const job = await emailQueue.getJob(row.id);
      expect(job).toBeTruthy();
      // Delivery is driven by BullMQ's delay, not by any timer of ours.
      expect(job!.opts.delay).toBeGreaterThan(0);
    }

    stopReconcileSweep();
  });
});
