import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Worker } from 'bullmq';
import { EMAIL_STATUS, nextHourWindowStart } from '@reachinbox/shared';
import { env } from '../../src/config/env.js';
import { prisma, disconnectDatabase } from '../../src/lib/prisma.js';
import { disconnectRedis } from '../../src/lib/redis.js';
import { closeQueue, emailQueue } from '../../src/queue/emailQueue.js';
import { createEmailWorker } from '../../src/queue/emailWorker.js';
import { hourlyQuota } from '../../src/ratelimit/rateLimiter.js';
import { scheduleCampaign } from '../../src/scheduler/scheduleCampaign.js';
import { createSender, createUser, resetAll, waitFor } from '../helpers.js';

/**
 * "On hitting the hourly limit, do not drop or permanently fail jobs — delay or
 * reschedule them into the next available hour window."
 *
 * A real `Worker` is run against a real Redis here, rather than calling the
 * processor directly: the deferral path uses `moveToDelayed` + `DelayedError`,
 * which only behaves correctly inside BullMQ's own job lifecycle.
 *
 * The quota is deliberately exhausted *before* the worker starts, so every job
 * takes the throttled branch and none reaches SMTP — these sender rows point at
 * `smtp.invalid`. Real delivery is covered by `npm run e2e`.
 */

let worker: Worker | null = null;

beforeEach(resetAll);

afterEach(async () => {
  if (worker) {
    // `false` would abandon jobs mid-flight; wait for the active ones instead.
    await worker.close();
    worker = null;
  }
});

afterAll(async () => {
  await resetAll();
  await closeQueue();
  await disconnectDatabase();
  await disconnectRedis();
});

/** Burns `count` slots so the next reservation is guaranteed to be refused. */
async function exhaust(senderId: string, count: number, limit: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await hourlyQuota.reserve({ senderId, senderLimit: limit, globalLimit: 100_000 });
  }
}

async function scheduleDueNow(senderId: string, userId: string, count: number) {
  const { campaign } = await scheduleCampaign({
    userId,
    senderId,
    subject: 'Throttled batch',
    bodyHtml: '<p>hello</p>',
    recipients: Array.from({ length: count }, (_, i) => `t${i}@example.com`),
    // Due immediately, so the worker picks them up without waiting.
    startAt: new Date(Date.now() - 1000),
    delayBetweenMs: 0,
    hourlyLimit: 0,
  });
  return campaign;
}

describe('per-sender hourly limit', () => {
  it('defers every over-cap job into the next window instead of failing it', async () => {
    const user = await createUser();
    const sender = await createSender({ maxEmailsPerHour: 3 });

    await exhaust(sender.id, 3, 3);
    const campaign = await scheduleDueNow(sender.id, user.id, 4);
    const windowStart = nextHourWindowStart(Date.now());

    worker = createEmailWorker();

    await waitFor(async () => {
      const done = await prisma.emailJob.count({
        where: { campaignId: campaign.id, rescheduleCount: { gte: 1 } },
      });
      return done === 4;
    });

    const rows = await prisma.emailJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { seq: 'asc' },
    });

    for (const row of rows) {
      // Deferred, not dropped and not failed — the requirement verbatim.
      expect(row.status).toBe(EMAIL_STATUS.SCHEDULED);
      expect(row.scheduledAt.getTime()).toBeGreaterThanOrEqual(windowStart);
      expect(row.rescheduleCount).toBe(1);
      // Being throttled is not a delivery failure, so no retry was consumed.
      expect(row.attempts).toBe(0);
      expect(row.lockedBy).toBeNull();
    }

    expect(rows.some((row) => row.status === EMAIL_STATUS.FAILED)).toBe(false);
    expect(rows.some((row) => row.status === EMAIL_STATUS.SENT)).toBe(false);
  });

  it('keeps the BullMQ job alive and delayed to the same instant as the row', async () => {
    const user = await createUser();
    const sender = await createSender({ maxEmailsPerHour: 1 });

    await exhaust(sender.id, 1, 1);
    const campaign = await scheduleDueNow(sender.id, user.id, 2);

    worker = createEmailWorker();

    await waitFor(async () => {
      const deferred = await prisma.emailJob.count({
        where: { campaignId: campaign.id, rescheduleCount: { gte: 1 } },
      });
      return deferred === 2;
    });

    const rows = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });

    for (const row of rows) {
      const job = await emailQueue.getJob(row.id);
      // Still queued: if the job had been discarded, the row's new scheduledAt
      // would be a promise nothing would ever keep.
      expect(job).toBeTruthy();
      expect(await job!.getState()).toBe('delayed');

      // `job.delay` is rewritten by `moveToDelayed` and counts from now, not
      // from `job.timestamp` (which stays at the original creation time).
      const firesAt = Date.now() + (job!.delay ?? 0);
      expect(Math.abs(firesAt - row.scheduledAt.getTime())).toBeLessThan(2000);
    }

    const counts = await emailQueue.getJobCounts('failed');
    expect(counts.failed).toBe(0);
  });

  it('preserves campaign order across the deferral', async () => {
    const user = await createUser();
    const sender = await createSender({ maxEmailsPerHour: 1 });

    await exhaust(sender.id, 1, 1);
    const campaign = await scheduleDueNow(sender.id, user.id, 5);

    worker = createEmailWorker();

    await waitFor(async () => {
      const deferred = await prisma.emailJob.count({
        where: { campaignId: campaign.id, rescheduleCount: { gte: 1 } },
      });
      return deferred === 5;
    });

    const rows = await prisma.emailJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { seq: 'asc' },
    });
    const times = rows.map((row) => row.scheduledAt.getTime());

    // Ordering is "as much as possible": with MIN_DELAY_BETWEEN_SENDS_MS=0 in
    // the test config there is no spacing to preserve it by, so the guarantee
    // is non-decreasing rather than strictly increasing.
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('writes an audit event naming the ceiling that was hit', async () => {
    const user = await createUser();
    const sender = await createSender({ maxEmailsPerHour: 1 });

    await exhaust(sender.id, 1, 1);
    const campaign = await scheduleDueNow(sender.id, user.id, 1);

    worker = createEmailWorker();

    await waitFor(async () => {
      const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
      return row.rescheduleCount >= 1;
    });

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const events = await prisma.emailEvent.findMany({
      where: { emailJobId: row.id },
      orderBy: { createdAt: 'asc' },
    });

    // The trail should read: claimed -> deferred, with the reason legible to a
    // human debugging a campaign that is taking longer than expected.
    expect(events.map((event) => event.status)).toContain(EMAIL_STATUS.PROCESSING);
    expect(events.some((event) => /sender hourly quota reached/i.test(event.message ?? ''))).toBe(
      true,
    );
  });
});

describe('global hourly limit', () => {
  it('defers when the deployment-wide ceiling is reached, even for a fresh sender', async () => {
    const user = await createUser();
    const sender = await createSender({ maxEmailsPerHour: 1000 });

    // Burn the global allowance through some *other* sender, so this one is
    // well within its own limit and can only be stopped by the global cap.
    await exhaust('unrelated-sender', env.MAX_EMAILS_PER_HOUR, env.MAX_EMAILS_PER_HOUR);

    const campaign = await scheduleDueNow(sender.id, user.id, 2);
    worker = createEmailWorker();

    await waitFor(async () => {
      const deferred = await prisma.emailJob.count({
        where: { campaignId: campaign.id, rescheduleCount: { gte: 1 } },
      });
      return deferred === 2;
    });

    const rows = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });
    expect(rows.every((row) => row.status === EMAIL_STATUS.SCHEDULED)).toBe(true);

    const row = rows[0]!;
    const events = await prisma.emailEvent.findMany({ where: { emailJobId: row.id } });
    expect(events.some((event) => /global hourly quota reached/i.test(event.message ?? ''))).toBe(
      true,
    );
  });
});

describe('reschedule budget', () => {
  it('fails a job that has bounced off the quota MAX_RESCHEDULES times', async () => {
    const user = await createUser();
    const sender = await createSender({ maxEmailsPerHour: 1 });

    await exhaust(sender.id, 1, 1);
    const campaign = await scheduleDueNow(sender.id, user.id, 1);

    // Pretend this job has already been bounced to the ceiling. Without this
    // guard a permanently over-subscribed sender would ping-pong its backlog
    // forever, and the dashboard would never show anything conclusive.
    await prisma.emailJob.updateMany({
      where: { campaignId: campaign.id },
      data: { rescheduleCount: env.MAX_RESCHEDULES },
    });

    worker = createEmailWorker();

    await waitFor(async () => {
      const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
      return row.status === EMAIL_STATUS.FAILED;
    });

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(row.lastError).toMatch(/MAX_RESCHEDULES/);
  });
});

describe('worker short-circuits', () => {
  it('does not send a job that was cancelled after being queued', async () => {
    const user = await createUser();
    const sender = await createSender();
    const campaign = await scheduleDueNow(sender.id, user.id, 1);

    await prisma.emailJob.updateMany({
      where: { campaignId: campaign.id },
      data: { status: EMAIL_STATUS.CANCELLED },
    });

    worker = createEmailWorker();

    await waitFor(async () => (await emailQueue.getJobCounts('completed')).completed === 1);

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    // Untouched: no claim, no attempt, and crucially no SMTP call to a sender
    // whose host does not resolve — which would have failed the test loudly.
    expect(row.status).toBe(EMAIL_STATUS.CANCELLED);
    expect(row.attempts).toBe(0);
  });

  it('does not re-send a job that is already SENT', async () => {
    const user = await createUser();
    const sender = await createSender();
    const campaign = await scheduleDueNow(sender.id, user.id, 1);

    await prisma.emailJob.updateMany({
      where: { campaignId: campaign.id },
      data: { status: EMAIL_STATUS.SENT, sentAt: new Date(), messageId: '<already@sent>' },
    });

    worker = createEmailWorker();

    await waitFor(async () => (await emailQueue.getJobCounts('completed')).completed === 1);

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(row.messageId).toBe('<already@sent>');
    expect(row.attempts).toBe(0);

    // The audit trail is the proof: exactly one SENT transition, ever.
    const sentEvents = await prisma.emailEvent.count({
      where: { emailJobId: row.id, status: EMAIL_STATUS.SENT },
    });
    expect(sentEvents).toBe(0);
  });
});
