import { randomUUID } from 'node:crypto';
import type { Sender, User } from '@prisma/client';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';

/**
 * Wipes all mutable state between tests.
 *
 * TRUNCATE ... CASCADE in one statement rather than ordered deletes, so the
 * foreign keys do not dictate the order and a new table cannot silently be
 * left behind.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE email_events, email_jobs, attachments, campaigns, senders, users RESTART IDENTITY CASCADE',
  );
}

/** Removes only this test run's Redis keys, never the whole server. */
export async function resetRedis(): Promise<void> {
  const keys = await redis.keys(`${env.QUEUE_PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
}

export async function resetAll(): Promise<void> {
  await Promise.all([resetDatabase(), resetRedis()]);
}

export async function createUser(overrides: Partial<User> = {}): Promise<User> {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${randomUUID()}@example.com`,
      name: overrides.name ?? 'Test User',
      avatarUrl: overrides.avatarUrl ?? null,
    },
  });
}

/**
 * A sender row with credentials that point nowhere.
 *
 * Deliberate: the integration suite covers scheduling, claiming and rate
 * limiting, none of which reach SMTP. Real delivery is verified separately by
 * `npm run e2e` against live Ethereal accounts.
 */
export async function createSender(overrides: Partial<Sender> = {}): Promise<Sender> {
  return prisma.sender.create({
    data: {
      name: overrides.name ?? 'Test Sender',
      fromEmail: overrides.fromEmail ?? `sender-${randomUUID()}@example.com`,
      smtpHost: overrides.smtpHost ?? 'smtp.invalid',
      smtpPort: overrides.smtpPort ?? 587,
      smtpSecure: overrides.smtpSecure ?? false,
      smtpUser: overrides.smtpUser ?? 'test',
      smtpPass: overrides.smtpPass ?? 'test',
      isActive: overrides.isActive ?? true,
      maxEmailsPerHour: overrides.maxEmailsPerHour ?? null,
    },
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` holds, so tests wait on state rather than on a clock. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 15_000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}
