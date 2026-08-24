import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { scopedLogger } from './logger.js';

const log = scopedLogger('redis');

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connections it owns:
 * ioredis' default of 20 makes commands throw during a Redis blip, which BullMQ
 * interprets as a hard failure instead of reconnecting and carrying on.
 */
const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
};

export function createRedisConnection(role: string): Redis {
  const connection = new Redis(env.REDIS_URL, baseOptions);

  connection.on('error', (error: Error) => {
    // Reconnection is automatic; log at warn so a transient blip is visible
    // without being treated as fatal.
    log.warn({ role, err: error.message }, 'redis connection error');
  });
  connection.on('ready', () => log.debug({ role }, 'redis ready'));

  return connection;
}

/**
 * Shared connection for application-level work (rate-limit counters, health
 * checks). Queue and worker instances get their own connections, because
 * BullMQ's blocking commands would otherwise stall these calls.
 */
export const redis = createRedisConnection('app');

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Verifies Redis is configured to actually persist BullMQ's data.
 *
 * Without AOF, a Redis restart silently drops every delayed job; with an
 * eviction policy, Redis may discard queue keys under memory pressure. Both
 * turn "scheduled" into "silently never sent", so we surface them loudly at
 * boot rather than letting a demo fail mysteriously.
 */
export async function checkRedisDurability(): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  try {
    const [appendonly, policy] = await Promise.all([
      redis.config('GET', 'appendonly') as Promise<string[]>,
      redis.config('GET', 'maxmemory-policy') as Promise<string[]>,
    ]);

    if (appendonly[1] !== 'yes') {
      warnings.push(
        'Redis has appendonly=no. Delayed jobs will be lost if Redis restarts. ' +
          'The DB reconciler will recover them at boot, but enable AOF for real durability.',
      );
    }
    if (policy[1] && policy[1] !== 'noeviction') {
      warnings.push(
        `Redis maxmemory-policy is "${policy[1]}". BullMQ requires "noeviction" — ` +
          'queue keys can otherwise be evicted under memory pressure.',
      );
    }
  } catch (error) {
    // Managed Redis providers frequently disable CONFIG GET. Not fatal.
    warnings.push(`Could not verify Redis persistence settings: ${(error as Error).message}`);
  }

  for (const warning of warnings) log.warn(warning);
  return { ok: warnings.length === 0, warnings };
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
