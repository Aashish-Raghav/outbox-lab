import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_STATUS } from '@reachinbox/shared';
import { prisma, disconnectDatabase } from '../../src/lib/prisma.js';
import { disconnectRedis } from '../../src/lib/redis.js';
import { emailQueue, enqueueEmailJobs, enqueueIfAbsent, closeQueue } from '../../src/queue/emailQueue.js';
import { scheduleCampaign } from '../../src/scheduler/scheduleCampaign.js';
import { createSender, createUser, resetAll } from '../helpers.js';

/**
 * "The same email queue must never be sent more than once."
 *
 * The design layers several independent guards rather than trusting one. These
 * tests exercise each layer on its own, so a regression points at the specific
 * guard that broke instead of at a vague end-to-end failure.
 */

beforeEach(resetAll);

afterAll(async () => {
  await resetAll();
  await closeQueue();
  await disconnectDatabase();
  await disconnectRedis();
});

/**
 * The claim, replicated exactly as the worker performs it.
 *
 * This is the guard that actually matters under concurrency: Postgres evaluates
 * the status predicate as part of the UPDATE, so the check and the write cannot
 * be interleaved by another worker.
 */
async function claim(emailJobId: string, workerId: string): Promise<boolean> {
  const { count } = await prisma.emailJob.updateMany({
    where: {
      id: emailJobId,
      status: { in: [EMAIL_STATUS.SCHEDULED, EMAIL_STATUS.QUEUED] },
    },
    data: {
      status: EMAIL_STATUS.PROCESSING,
      attempts: { increment: 1 },
      lockedAt: new Date(),
      lockedBy: workerId,
    },
  });
  return count === 1;
}

describe('layer 1 — BullMQ jobId', () => {
  it('refuses a second job with the same id', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Idempotent enqueue',
      bodyHtml: '<p>hello</p>',
      recipients: ['a@example.com'],
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });

    // Simulate the reconciler racing the scheduler for the same row.
    await enqueueEmailJobs([
      { emailJobId: row.id, campaignId: campaign.id, seq: row.seq, scheduledAt: row.scheduledAt },
    ]);
    const outcome = await enqueueIfAbsent({
      emailJobId: row.id,
      campaignId: campaign.id,
      seq: row.seq,
      scheduledAt: row.scheduledAt,
    });

    expect(outcome).toBe('exists');

    const counts = await emailQueue.getJobCounts('delayed', 'waiting');
    expect((counts.delayed ?? 0) + (counts.waiting ?? 0)).toBe(1);
  });
});

describe('layer 2 — unique (campaignId, toEmail)', () => {
  it('collapses a repeated address within one campaign', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Duplicates',
      bodyHtml: '<p>hello</p>',
      // The route de-duplicates before this point; the constraint is the
      // backstop for anything that reaches the scheduler another way.
      recipients: ['dup@example.com', 'other@example.com'],
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    await expect(
      prisma.emailJob.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          senderId: sender.id,
          toEmail: 'dup@example.com',
          subject: 'Duplicates',
          bodyHtml: '<p>hello</p>',
          seq: 99,
          scheduledAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.emailJob.count({ where: { campaignId: campaign.id } })).toBe(2);
  });

  it('allows the same address in a different campaign', async () => {
    const user = await createUser();
    const sender = await createSender();

    const common = {
      userId: user.id,
      senderId: sender.id,
      bodyHtml: '<p>hello</p>',
      recipients: ['same@example.com'],
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    };

    await scheduleCampaign({ ...common, subject: 'First' });
    await scheduleCampaign({ ...common, subject: 'Second' });

    expect(await prisma.emailJob.count({ where: { toEmail: 'same@example.com' } })).toBe(2);
  });
});

describe('layer 3 — atomic claim', () => {
  /**
   * The headline test: ten workers race for one job. Exactly one may win, or
   * the recipient gets the same email ten times.
   */
  it('lets exactly one of ten concurrent workers claim a job', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Claim race',
      bodyHtml: '<p>hello</p>',
      recipients: ['race@example.com'],
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claim(row.id, `worker-${i}`)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    const after = await prisma.emailJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(EMAIL_STATUS.PROCESSING);
    // Only the winner incremented, so the losers did not inflate the count.
    expect(after.attempts).toBe(1);
    expect(after.lockedBy).toMatch(/^worker-\d$/);
  });

  it('holds when many jobs are claimed concurrently', async () => {
    const user = await createUser();
    const sender = await createSender();
    const recipients = Array.from({ length: 25 }, (_, i) => `bulk-${i}@example.com`);

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Bulk claim race',
      bodyHtml: '<p>hello</p>',
      recipients,
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    const rows = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });

    // Four "workers" all try to claim every row.
    const attempts = rows.flatMap((row) =>
      Array.from({ length: 4 }, (_, i) => claim(row.id, `worker-${i}`)),
    );
    const results = await Promise.all(attempts);

    expect(results.filter(Boolean)).toHaveLength(rows.length);
  });

  it('refuses to re-claim a job that is already SENT', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Terminal',
      bodyHtml: '<p>hello</p>',
      recipients: ['sent@example.com'],
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await prisma.emailJob.update({
      where: { id: row.id },
      data: { status: EMAIL_STATUS.SENT, sentAt: new Date() },
    });

    // This is the retry-after-a-post-send-crash case.
    expect(await claim(row.id, 'late-worker')).toBe(false);
    expect((await prisma.emailJob.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      EMAIL_STATUS.SENT,
    );
  });

  it('refuses to claim a cancelled job', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Cancelled',
      bodyHtml: '<p>hello</p>',
      recipients: ['cancelled@example.com'],
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await prisma.emailJob.update({
      where: { id: row.id },
      data: { status: EMAIL_STATUS.CANCELLED },
    });

    // Covers cancelling a job that a worker has already pulled off the queue.
    expect(await claim(row.id, 'worker')).toBe(false);
  });
});

describe('scheduleCampaign', () => {
  it('materialises the cadence onto every row so it survives a restart', async () => {
    const user = await createUser();
    const sender = await createSender();
    const startAt = new Date(Date.now() + 3_600_000);

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Cadence',
      bodyHtml: '<p>hello</p>',
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
      startAt,
      delayBetweenMs: 30_000,
      hourlyLimit: 0,
    });

    const rows = await prisma.emailJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { seq: 'asc' },
    });

    expect(rows.map((row) => row.scheduledAt.getTime())).toEqual([
      startAt.getTime(),
      startAt.getTime() + 30_000,
      startAt.getTime() + 60_000,
    ]);
  });

  it('treats a start time in the past as "send now"', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Past',
      bodyHtml: '<p>hello</p>',
      recipients: ['past@example.com'],
      // The user may simply have taken a moment to press the button.
      startAt: new Date(Date.now() - 60_000),
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    expect(campaign.startAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('rejects a campaign with no valid recipients', async () => {
    const user = await createUser();
    const sender = await createSender();

    await expect(
      scheduleCampaign({
        userId: user.id,
        senderId: sender.id,
        subject: 'Empty',
        bodyHtml: '<p>hello</p>',
        recipients: [],
        delayBetweenMs: 0,
        hourlyLimit: 0,
      }),
    ).rejects.toThrow(/recipient/i);
  });

  it('refuses to schedule from a disabled sender', async () => {
    const user = await createUser();
    const sender = await createSender({ isActive: false });

    await expect(
      scheduleCampaign({
        userId: user.id,
        senderId: sender.id,
        subject: 'Disabled',
        bodyHtml: '<p>hello</p>',
        recipients: ['a@example.com'],
        delayBetweenMs: 0,
        hourlyLimit: 0,
      }),
    ).rejects.toThrow(/disabled/i);
  });

  it('strips scripts from the body before it is ever stored', async () => {
    const user = await createUser();
    const sender = await createSender();

    const { campaign } = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'XSS',
      bodyHtml: '<p>safe</p><script>alert(1)</script><img src=x onerror="alert(2)">',
      recipients: ['xss@example.com'],
      delayBetweenMs: 0,
      hourlyLimit: 0,
    });

    // Sanitised once at write time, so the stored copy, the delivered message
    // and the dashboard preview cannot disagree.
    expect(campaign.bodyHtml).not.toContain('<script');
    expect(campaign.bodyHtml).not.toContain('onerror');
    expect(campaign.bodyHtml).toContain('safe');

    const row = await prisma.emailJob.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(row.bodyHtml).not.toContain('<script');
  });

  it('handles a 1000-recipient batch in one transaction', async () => {
    const user = await createUser();
    // The suite-wide default is deliberately tiny; this mailbox is allowed the
    // 200/hour the assignment's load example uses.
    const sender = await createSender({ maxEmailsPerHour: 200 });
    const recipients = Array.from({ length: 1000 }, (_, i) => `load-${i}@example.com`);

    const result = await scheduleCampaign({
      userId: user.id,
      senderId: sender.id,
      subject: 'Load',
      bodyHtml: '<p>hello</p>',
      recipients,
      startAt: new Date(Date.now() + 3_600_000),
      delayBetweenMs: 0,
      hourlyLimit: 200,
    });

    expect(result.enqueued).toBe(1000);
    expect(await prisma.emailJob.count({ where: { campaignId: result.campaign.id } })).toBe(1000);
    // 1000 at 200/hour drains over five windows rather than being dropped.
    expect(result.windowsRequired).toBe(5);
    expect(result.throttledByHourlyLimit).toBe(true);
  });
});
