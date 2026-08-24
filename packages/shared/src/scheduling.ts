/**
 * Pure scheduling arithmetic.
 *
 * Isolated from Redis, Prisma and BullMQ so it can be unit-tested exhaustively
 * and reused by the dashboard to preview when a campaign will finish before the
 * user commits to it.
 */

export const HOUR_MS = 3_600_000;

/** Start of the fixed hour window containing `at`, as epoch ms. */
export function hourWindowStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** Identifier used in the Redis rate-limit keys. Stable and sortable. */
export function hourWindowId(at: number): number {
  return Math.floor(at / HOUR_MS);
}

/** Start of the next hour window after `at`, as epoch ms. */
export function nextHourWindowStart(at: number): number {
  return hourWindowStart(at) + HOUR_MS;
}

/** Milliseconds until the current hour window rolls over. Always >= 1. */
export function msUntilNextWindow(at: number): number {
  return Math.max(1, nextHourWindowStart(at) - at);
}

/**
 * When the email at position `seq` in a campaign should be attempted.
 *
 * Spacing the sends at insert time — rather than relying only on the worker's
 * limiter — means the intended cadence survives a restart: it is recorded on
 * each row instead of living in a worker's memory.
 */
export function scheduledAtForSeq(startAt: number, seq: number, delayBetweenMs: number): number {
  return startAt + seq * delayBetweenMs;
}

export interface CampaignProjection {
  /** When the final email is expected to be attempted, as epoch ms. */
  completesAt: number;
  /** How many hour windows the campaign will span. */
  windowsRequired: number;
  /** True when the hourly quota, not the per-email delay, is the bottleneck. */
  throttledByHourlyLimit: boolean;
}

/**
 * Projects when a campaign finishes under both constraints at once:
 * the per-email delay, and the hourly quota.
 *
 * Used for the "1000+ emails scheduled at the same time" case — the caller can
 * see up front that the batch will drain across several hour windows rather
 * than discovering it after the fact.
 */
export function projectCampaign(params: {
  startAt: number;
  recipientCount: number;
  delayBetweenMs: number;
  hourlyLimit: number;
}): CampaignProjection {
  const { startAt, recipientCount, delayBetweenMs, hourlyLimit } = params;

  if (recipientCount <= 0) {
    return { completesAt: startAt, windowsRequired: 0, throttledByHourlyLimit: false };
  }

  // Cadence alone: the last email lands `(n-1) * delay` after the start.
  const byDelay = scheduledAtForSeq(startAt, recipientCount - 1, delayBetweenMs);

  if (hourlyLimit <= 0) {
    return { completesAt: byDelay, windowsRequired: 1, throttledByHourlyLimit: false };
  }

  // Quota alone: the first window is partial (we may start mid-hour), and each
  // subsequent window admits a further `hourlyLimit` emails.
  const windowsRequired = Math.ceil(recipientCount / hourlyLimit);
  const byQuota =
    windowsRequired <= 1 ? byDelay : nextHourWindowStart(startAt) + (windowsRequired - 2) * HOUR_MS;

  return {
    completesAt: Math.max(byDelay, byQuota),
    windowsRequired,
    throttledByHourlyLimit: byQuota > byDelay,
  };
}

/**
 * Where a rate-limited job should land when it is bumped into the next window.
 *
 * The `seq` offset keeps a campaign's relative ordering intact across the bump:
 * without it, every deferred job would target the exact same millisecond and
 * drain in arbitrary order. The offset is clamped so it can never spill past
 * the window it was aimed at.
 */
export function rescheduleTarget(params: {
  now: number;
  seq: number;
  minDelayMs: number;
}): number {
  const { now, seq, minDelayMs } = params;
  const windowStart = nextHourWindowStart(now);
  const offset = minDelayMs > 0 ? (seq * minDelayMs) % HOUR_MS : 0;
  return windowStart + offset;
}
