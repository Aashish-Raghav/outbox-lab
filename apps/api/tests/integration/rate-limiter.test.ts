import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS, hourWindowId } from '@reachinbox/shared';
import { HourlyQuotaLimiter, resolveSenderLimit } from '../../src/ratelimit/rateLimiter.js';
import { createRedisConnection, disconnectRedis } from '../../src/lib/redis.js';
import { env } from '../../src/config/env.js';
import { resetRedis } from '../helpers.js';

/**
 * The hourly quota is the requirement most easily got wrong: a check-then-set
 * against Redis looks correct in a single-threaded test and oversubscribes the
 * moment two workers race. These tests fire genuinely concurrent clients at a
 * real Redis to show the Lua script holds the line.
 */

const limiter = new HourlyQuotaLimiter();

beforeEach(resetRedis);

afterAll(async () => {
  await resetRedis();
  await disconnectRedis();
});

describe('HourlyQuotaLimiter', () => {
  it('allows exactly up to the per-sender limit', async () => {
    const senderId = 'sender-basic';

    for (let i = 0; i < 5; i += 1) {
      const decision = await limiter.reserve({ senderId, senderLimit: 5, globalLimit: 1000 });
      expect(decision.allowed).toBe(true);
    }

    const overflow = await limiter.reserve({ senderId, senderLimit: 5, globalLimit: 1000 });
    expect(overflow.allowed).toBe(false);
    if (!overflow.allowed) {
      expect(overflow.scope).toBe('sender');
      expect(overflow.retryAfterMs).toBeGreaterThan(0);
      expect(overflow.retryAfterMs).toBeLessThanOrEqual(HOUR_MS);
    }
  });

  it('reports the remaining allowance as it is consumed', async () => {
    const senderId = 'sender-remaining';

    const first = await limiter.reserve({ senderId, senderLimit: 3, globalLimit: 1000 });
    expect(first.allowed && first.senderRemaining).toBe(2);

    const second = await limiter.reserve({ senderId, senderLimit: 3, globalLimit: 1000 });
    expect(second.allowed && second.senderRemaining).toBe(1);
  });

  /**
   * The headline property. 50 clients race for 10 slots; the count must be
   * exactly 10, never 11 and never 9.
   */
  it('never oversubscribes under 50 concurrent reservations', async () => {
    const senderId = 'sender-race';
    const CAP = 10;

    const decisions = await Promise.all(
      Array.from({ length: 50 }, () =>
        limiter.reserve({ senderId, senderLimit: CAP, globalLimit: 1000 }),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(CAP);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(40);
  });

  /**
   * The same race, but each client on its own Redis connection — closer to
   * several worker *processes* than to concurrent promises on one socket.
   */
  it('holds across independent Redis connections', async () => {
    const senderId = 'sender-multiproc';
    const CAP = 7;
    const connections = Array.from({ length: 12 }, () => createRedisConnection('test'));

    try {
      const decisions = await Promise.all(
        connections.map((connection) =>
          new HourlyQuotaLimiter(connection).reserve({
            senderId,
            senderLimit: CAP,
            globalLimit: 1000,
          }),
        ),
      );

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(CAP);
    } finally {
      await Promise.all(connections.map((connection) => connection.quit()));
    }
  });

  it('enforces the global ceiling across different senders', async () => {
    // Two senders, each well under its own limit, must still not exceed the
    // deployment-wide cap between them.
    const decisions = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        limiter.reserve({ senderId: 'sender-a', senderLimit: 100, globalLimit: 6 }),
      ),
      ...Array.from({ length: 5 }, () =>
        limiter.reserve({ senderId: 'sender-b', senderLimit: 100, globalLimit: 6 }),
      ),
    ]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(6);

    const refused = decisions.find((decision) => !decision.allowed);
    expect(refused && !refused.allowed && refused.scope).toBe('global');
  });

  /**
   * Both ceilings are checked before *either* counter is mutated. Otherwise a
   * request refused by the sender limit would still have burned global quota,
   * and the deployment would slowly under-deliver for no visible reason.
   */
  it('does not consume global quota when the sender limit refuses', async () => {
    const senderId = 'sender-capped';

    await limiter.reserve({ senderId, senderLimit: 1, globalLimit: 100 });

    const refused = await limiter.reserve({ senderId, senderLimit: 1, globalLimit: 100 });
    expect(refused.allowed).toBe(false);

    // Global should show exactly the one genuinely-allowed send.
    const usage = await limiter.usage(senderId);
    expect(usage.global).toBe(1);
    expect(usage.sender).toBe(1);

    // And a different sender still has the full global allowance minus that one.
    const other = await limiter.reserve({
      senderId: 'sender-other',
      senderLimit: 10,
      globalLimit: 100,
    });
    expect(other.allowed && other.globalRemaining).toBe(98);
  });

  it('starts a fresh allowance in the next hour window', async () => {
    const senderId = 'sender-window';
    const now = Date.parse('2026-08-24T10:59:59.000Z');

    await limiter.reserve({ senderId, senderLimit: 1, globalLimit: 100, now });
    const refused = await limiter.reserve({ senderId, senderLimit: 1, globalLimit: 100, now });
    expect(refused.allowed).toBe(false);

    // One second later the window has rolled over.
    const nextWindow = now + 1000;
    expect(hourWindowId(nextWindow)).toBe(hourWindowId(now) + 1);

    const allowed = await limiter.reserve({
      senderId,
      senderLimit: 1,
      globalLimit: 100,
      now: nextWindow,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('refunds within the window but not after it rolls over', async () => {
    const senderId = 'sender-refund';
    const now = Date.now();

    await limiter.reserve({ senderId, senderLimit: 5, globalLimit: 100, now });
    expect((await limiter.usage(senderId, now)).sender).toBe(1);

    await limiter.refund(senderId, now);
    expect((await limiter.usage(senderId, now)).sender).toBe(0);

    // A refund aimed at an already-closed window must be ignored: crediting it
    // to the current window would hand out quota that was never spent there.
    await limiter.reserve({ senderId, senderLimit: 5, globalLimit: 100, now });
    await limiter.refund(senderId, now - 2 * HOUR_MS);
    expect((await limiter.usage(senderId, now)).sender).toBe(1);
  });

  it('never lets a counter go negative', async () => {
    const senderId = 'sender-floor';
    const now = Date.now();

    await limiter.reserve({ senderId, senderLimit: 5, globalLimit: 100, now });
    await limiter.refund(senderId, now);
    await limiter.refund(senderId, now);
    await limiter.refund(senderId, now);

    expect((await limiter.usage(senderId, now)).sender).toBe(0);
  });

  it('expires its counters so no reset job is needed', async () => {
    const senderId = 'sender-ttl';
    await limiter.reserve({ senderId, senderLimit: 5, globalLimit: 100 });

    const connection = createRedisConnection('test-ttl');
    try {
      const key = `${env.QUEUE_PREFIX}:rl:sender:${senderId}:${hourWindowId(Date.now())}`;
      const ttl = await connection.ttl(key);

      // Set on the 0 -> 1 transition and comfortably longer than one window,
      // so clock skew between instances cannot resurrect a stale counter.
      expect(ttl).toBeGreaterThan(HOUR_MS / 1000);
    } finally {
      await connection.quit();
    }
  });
});

describe('resolveSenderLimit', () => {
  it('falls back to the deployment default', () => {
    expect(resolveSenderLimit({})).toBe(env.MAX_EMAILS_PER_HOUR_PER_SENDER);
  });

  it('lets a sender row tighten the default', () => {
    expect(resolveSenderLimit({ senderMaxPerHour: 2 })).toBe(2);
  });

  it('lets a campaign tighten it further', () => {
    expect(resolveSenderLimit({ campaignHourlyLimit: 1, senderMaxPerHour: 4 })).toBe(1);
  });

  it('never lets a campaign raise the ceiling above the sender', () => {
    // A user asking for 10_000/hour in the compose form must not be able to
    // override what the mailbox is actually allowed to send.
    expect(resolveSenderLimit({ campaignHourlyLimit: 10_000, senderMaxPerHour: 4 })).toBe(4);
  });

  it('treats 0 as "unset" rather than "no sends allowed"', () => {
    expect(resolveSenderLimit({ campaignHourlyLimit: 0, senderMaxPerHour: 4 })).toBe(4);
  });
});
