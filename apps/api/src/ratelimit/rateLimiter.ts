import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { HOUR_MS, hourWindowId, msUntilNextWindow } from '@reachinbox/shared';
import { env } from '../config/env.js';
import { redis as defaultRedis } from '../lib/redis.js';
import { scopedLogger } from '../lib/logger.js';

const log = scopedLogger('ratelimit');

const here = path.dirname(fileURLToPath(import.meta.url));
const LUA_SOURCE = readFileSync(path.join(here, 'hourly-quota.lua'), 'utf8');

/**
 * Keys expire one full window after the one they count, so a clock skew of a
 * few minutes between instances can never resurrect a stale counter.
 */
const KEY_TTL_SECONDS = Math.ceil((HOUR_MS * 2) / 1000);

export interface QuotaGranted {
  allowed: true;
  globalRemaining: number;
  senderRemaining: number;
}

export interface QuotaRefused {
  allowed: false;
  /** Which ceiling was hit — surfaced in logs and the job's audit trail. */
  scope: 'global' | 'sender';
  /** Milliseconds until the next window opens. */
  retryAfterMs: number;
}

export type QuotaDecision = QuotaGranted | QuotaRefused;

function globalKey(windowId: number): string {
  return `${env.QUEUE_PREFIX}:rl:global:${windowId}`;
}

function senderKey(senderId: string, windowId: number): string {
  return `${env.QUEUE_PREFIX}:rl:sender:${senderId}:${windowId}`;
}

/**
 * Redis-backed hourly send quota.
 *
 * Correctness properties:
 *  - **Atomic**: reservation of the global and per-sender counters happens in a
 *    single Lua script, so concurrent workers cannot oversubscribe either one.
 *  - **Shared**: state lives in Redis, never in process memory, so it holds
 *    across worker processes, containers and restarts.
 *  - **Self-expiring**: counters are keyed by hour window and TTL'd, so there is
 *    no reset job to run — which is what keeps this cron-free.
 */
export class HourlyQuotaLimiter {
  private readonly redis: Redis;
  private scriptSha: string | null = null;

  constructor(redisClient: Redis = defaultRedis) {
    this.redis = redisClient;
  }

  /**
   * Loads the Lua script into Redis' script cache once, then invokes it by SHA.
   * If Redis was restarted and lost its cache, we reload and retry transparently.
   */
  private async run(keys: string[], args: (string | number)[]): Promise<unknown> {
    if (!this.scriptSha) {
      this.scriptSha = await this.redis.script('LOAD', LUA_SOURCE) as string;
    }

    try {
      return await this.redis.evalsha(this.scriptSha, keys.length, ...keys, ...args);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (!message.includes('NOSCRIPT')) throw error;

      log.debug('lua script cache miss, reloading');
      this.scriptSha = (await this.redis.script('LOAD', LUA_SOURCE)) as string;
      return this.redis.evalsha(this.scriptSha, keys.length, ...keys, ...args);
    }
  }

  /**
   * Attempts to reserve one send slot for `senderId`.
   *
   * On success the quota is consumed immediately, *before* the SMTP call. That
   * is deliberate: reserving up front means a crash mid-send can only ever
   * under-use the quota, never exceed a provider's real limit. See
   * `RATE_LIMIT_REFUND_ON_FAILURE` for the opposite trade-off.
   */
  async reserve(params: {
    senderId: string;
    /** Effective per-sender ceiling for this job (campaign < sender < env). */
    senderLimit: number;
    /** Effective global ceiling. */
    globalLimit?: number;
    now?: number;
  }): Promise<QuotaDecision> {
    const now = params.now ?? Date.now();
    const windowId = hourWindowId(now);
    const globalLimit = params.globalLimit ?? env.MAX_EMAILS_PER_HOUR;
    const retryAfterMs = msUntilNextWindow(now);

    const result = (await this.run(
      [globalKey(windowId), senderKey(params.senderId, windowId)],
      [globalLimit, params.senderLimit, KEY_TTL_SECONDS, retryAfterMs],
    )) as [number, number, string | number];

    const [ok, second, third] = result;

    if (ok === 1) {
      return {
        allowed: true,
        globalRemaining: Number(second),
        senderRemaining: Number(third),
      };
    }

    return {
      allowed: false,
      scope: String(third) === 'global' ? 'global' : 'sender',
      retryAfterMs: Number(second),
    };
  }

  /**
   * Returns a previously reserved slot.
   *
   * Only called when `RATE_LIMIT_REFUND_ON_FAILURE=true` and the send failed
   * before the provider accepted it. Guarded against dropping below zero, and
   * a no-op once the window has rolled over — refunding into a *new* window
   * would hand out quota that was never spent there.
   */
  async refund(senderId: string, reservedAtMs: number): Promise<void> {
    const now = Date.now();
    const windowId = hourWindowId(reservedAtMs);

    if (windowId !== hourWindowId(now)) {
      log.debug({ senderId }, 'skipping refund: reservation window already rolled over');
      return;
    }

    const keys = [globalKey(windowId), senderKey(senderId, windowId)];
    const pipeline = this.redis.multi();
    for (const key of keys) {
      // DECR only if the key exists, so we never create a negative counter.
      pipeline.eval(
        `if redis.call('EXISTS', KEYS[1]) == 1 and tonumber(redis.call('GET', KEYS[1])) > 0 then
           return redis.call('DECR', KEYS[1])
         end
         return 0`,
        1,
        key,
      );
    }
    await pipeline.exec();
  }

  /** Current usage, for the health endpoint and the senders API. */
  async usage(senderId: string, now = Date.now()): Promise<{ global: number; sender: number }> {
    const windowId = hourWindowId(now);
    const [globalUsed, senderUsed] = await this.redis.mget(
      globalKey(windowId),
      senderKey(senderId, windowId),
    );

    return {
      global: Number(globalUsed ?? 0),
      sender: Number(senderUsed ?? 0),
    };
  }

  /** Test helper: wipes every counter for the given window. */
  async reset(now = Date.now()): Promise<void> {
    const windowId = hourWindowId(now);
    const keys = await this.redis.keys(`${env.QUEUE_PREFIX}:rl:*:${windowId}`);
    const senderKeys = await this.redis.keys(`${env.QUEUE_PREFIX}:rl:sender:*:${windowId}`);
    const all = [...new Set([...keys, ...senderKeys])];
    if (all.length > 0) await this.redis.del(...all);
  }
}

export const hourlyQuota = new HourlyQuotaLimiter();

/**
 * Resolves the per-sender ceiling actually in force for a job.
 *
 * Precedence is most-specific-wins, and a campaign can only ever tighten the
 * limit, never raise it above what the sender or the deployment allows.
 */
export function resolveSenderLimit(params: {
  campaignHourlyLimit?: number | null;
  senderMaxPerHour?: number | null;
}): number {
  const deploymentCeiling = env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const senderCeiling = params.senderMaxPerHour ?? deploymentCeiling;

  const campaignLimit = params.campaignHourlyLimit;
  if (campaignLimit && campaignLimit > 0) {
    return Math.min(campaignLimit, senderCeiling);
  }

  return senderCeiling;
}
