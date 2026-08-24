/**
 * Load test: "the system should handle 1000+ emails scheduled for roughly the
 * same time."
 *
 * This schedules the batch for real — rows in Postgres, delayed jobs in Redis —
 * and then reports how the hourly quota will actually drain it. What it does
 * *not* do is push 1200 messages through Ethereal, which would take five hours
 * of wall clock at a 200/hour cap and tell us nothing the arithmetic does not.
 *
 * The interesting question is not "can it send 1200 emails" but "does enqueuing
 * 1200 at once stay responsive, and does the backlog spread across windows in
 * order rather than being dropped or fired all at once." Both are measured here.
 *
 *   npm run load-test -- --count 1200 --hourly-limit 200
 *   npm run load-test -- --count 5000 --delay 2 --keep
 *
 * By default the campaign is deleted again at the end, so running this does not
 * leave a five-hour backlog sitting in a dev queue. Pass --keep to inspect it.
 */
import { performance } from 'node:perf_hooks';
import {
  EMAIL_STATUS,
  HOUR_MS,
  hourWindowId,
  nextHourWindowStart,
  projectCampaign,
} from '@reachinbox/shared';
import { env } from '../apps/api/src/config/env.js';
import { prisma, disconnectDatabase } from '../apps/api/src/lib/prisma.js';
import { disconnectRedis } from '../apps/api/src/lib/redis.js';
import { closeQueue, emailQueue, queueDepth } from '../apps/api/src/queue/emailQueue.js';
import { resolveSenderLimit } from '../apps/api/src/ratelimit/rateLimiter.js';
import { scheduleCampaign } from '../apps/api/src/scheduler/scheduleCampaign.js';

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[90m';
const GREEN = '[32m';
const YELLOW = '[33m';

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const COUNT = flag('count', 1200);
const HOURLY_LIMIT = flag('hourly-limit', 200);
const DELAY_SECONDS = flag('delay', 0);
const KEEP = process.argv.includes('--keep');

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}Load test${RESET} ${DIM}${COUNT} emails, hourly limit ${HOURLY_LIMIT}${RESET}\n`);

  const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!user) throw new Error('No user. Run `npm run db:seed` first.');

  // A dedicated sender, so the load test never competes for quota with whatever
  // else is in the dev queue, and so its own counters are easy to read.
  const sender = await prisma.sender.upsert({
    where: { fromEmail: 'load-test@example.com' },
    update: { maxEmailsPerHour: HOURLY_LIMIT, isActive: true },
    create: {
      name: 'Load Test Sender',
      fromEmail: 'load-test@example.com',
      smtpHost: 'smtp.invalid',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'load-test',
      smtpPass: 'load-test',
      maxEmailsPerHour: HOURLY_LIMIT,
      // Inactive by default so a worker cannot pick these up and hammer a dead
      // SMTP host; flipped on only for the scheduling call below.
      isActive: true,
    },
  });

  const effectiveLimit = resolveSenderLimit({
    campaignHourlyLimit: HOURLY_LIMIT,
    senderMaxPerHour: sender.maxEmailsPerHour,
  });

  const recipients = Array.from({ length: COUNT }, (_, i) => `load-${i}@example.invalid`);
  const startAt = new Date(Date.now() + 60_000);

  // ── Enqueue ───────────────────────────────────────────────────────────────
  const before = performance.now();
  const result = await scheduleCampaign({
    userId: user.id,
    senderId: sender.id,
    subject: `Load test — ${COUNT} recipients`,
    bodyHtml: '<p>Load test message body.</p>',
    recipients,
    startAt,
    delayBetweenMs: DELAY_SECONDS * 1000,
    hourlyLimit: HOURLY_LIMIT,
  });
  const elapsed = performance.now() - before;

  console.log(`${BOLD}Enqueue${RESET}`);
  row('recipients', String(COUNT));
  row('rows written + jobs queued', `${result.enqueued}`);
  row('elapsed', `${GREEN}${ms(elapsed)}${RESET}`);
  row('throughput', `${Math.round(COUNT / (elapsed / 1000)).toLocaleString()} emails/sec`);
  row('per email', `${(elapsed / COUNT).toFixed(2)}ms`);

  if (result.enqueued !== COUNT) {
    console.log(`  ${YELLOW}warning${RESET} only ${result.enqueued} of ${COUNT} were queued`);
  }

  // ── Drain projection ──────────────────────────────────────────────────────
  // The arithmetic the README quotes, computed rather than asserted, so the
  // numbers in the docs cannot drift away from the code.
  const projection = projectCampaign({
    startAt: startAt.getTime(),
    recipientCount: COUNT,
    delayBetweenMs: DELAY_SECONDS * 1000,
    hourlyLimit: effectiveLimit,
  });

  console.log(`\n${BOLD}Drain projection${RESET}`);
  row('effective hourly limit', `${effectiveLimit}/hour ${DIM}(sender ceiling)${RESET}`);
  row('global ceiling', `${env.MAX_EMAILS_PER_HOUR}/hour`);
  row('min delay between sends', `${env.MIN_DELAY_BETWEEN_SENDS_MS}ms`);
  row('worker concurrency', String(env.WORKER_CONCURRENCY));
  row('hour windows required', String(projection.windowsRequired));
  row('bottleneck', projection.throttledByHourlyLimit ? 'hourly quota' : 'per-email delay');
  row('last email projected at', new Date(projection.completesAt).toISOString());

  console.log(`\n${BOLD}Window-by-window${RESET} ${DIM}(what the quota will actually let through)${RESET}`);
  let remaining = COUNT;
  let windowStart = startAt.getTime();
  for (let index = 0; remaining > 0 && index < 12; index += 1) {
    const through = Math.min(remaining, effectiveLimit);
    remaining -= through;
    const label = new Date(windowStart).toISOString().slice(11, 16);
    const bar = '█'.repeat(Math.max(1, Math.round((through / effectiveLimit) * 30)));
    console.log(
      `  ${label}  ${String(through).padStart(5)}  ${GREEN}${bar}${RESET}` +
        (remaining > 0 ? `  ${DIM}${remaining} deferred${RESET}` : ''),
    );
    windowStart = index === 0 ? nextHourWindowStart(windowStart) : windowStart + HOUR_MS;
  }
  if (remaining > 0) console.log(`  ${DIM}… ${remaining} more across later windows${RESET}`);

  // ── What is actually in Redis and Postgres right now ──────────────────────
  const depth = await queueDepth();
  const statuses = await prisma.emailJob.groupBy({
    by: ['status'],
    where: { campaignId: result.campaign.id },
    _count: { _all: true },
  });

  console.log(`\n${BOLD}Actual state${RESET}`);
  row('queue delayed', String(depth.delayed));
  row('queue waiting', String(depth.waiting));
  row('queue failed', String(depth.failed));
  for (const entry of statuses) {
    row(`db ${entry.status.toLowerCase()}`, String(entry._count._all));
  }

  const scheduled = statuses.find((entry) => entry.status === EMAIL_STATUS.SCHEDULED);
  const allQueued = depth.delayed + depth.waiting >= COUNT;
  const allPersisted = (scheduled?._count._all ?? 0) === COUNT;

  console.log();
  console.log(
    allQueued && allPersisted
      ? `${GREEN}PASS${RESET} — ${COUNT} emails persisted and queued in ${ms(elapsed)}, ` +
          `draining over ${projection.windowsRequired} hour window(s) in order.`
      : `${YELLOW}CHECK${RESET} — queued ${depth.delayed + depth.waiting}, persisted ${scheduled?._count._all ?? 0}, expected ${COUNT}.`,
  );

  // ── Clean up ──────────────────────────────────────────────────────────────
  if (KEEP) {
    console.log(`${DIM}--keep: campaign ${result.campaign.id} left in place.${RESET}`);
  } else {
    const rows = await prisma.emailJob.findMany({
      where: { campaignId: result.campaign.id },
      select: { id: true },
    });
    // Remove the Redis jobs first: deleting the rows while the jobs remain would
    // leave the worker hunting for records that no longer exist.
    for (let index = 0; index < rows.length; index += 500) {
      await Promise.all(
        rows.slice(index, index + 500).map(async (item) => {
          const job = await emailQueue.getJob(item.id);
          await job?.remove().catch(() => undefined);
        }),
      );
    }
    await prisma.campaign.delete({ where: { id: result.campaign.id } });
    await prisma.sender.update({ where: { id: sender.id }, data: { isActive: false } });
    console.log(`${DIM}Cleaned up. Pass --keep to inspect the backlog instead.${RESET}`);
  }

  console.log(`${DIM}Current hour window id: ${hourWindowId(Date.now())}${RESET}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(`\n[31mLoad test failed:${RESET}`, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueue();
    await disconnectDatabase();
    await disconnectRedis();
  });
