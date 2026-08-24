import { describe, expect, it } from 'vitest';
import {
  HOUR_MS,
  hourWindowId,
  hourWindowStart,
  msUntilNextWindow,
  nextHourWindowStart,
  projectCampaign,
  rescheduleTarget,
  scheduledAtForSeq,
} from '@reachinbox/shared';

/** 2026-08-24T10:30:00.000Z — deliberately mid-window. */
const MID_WINDOW = Date.parse('2026-08-24T10:30:00.000Z');
const WINDOW_START = Date.parse('2026-08-24T10:00:00.000Z');

describe('hour windows', () => {
  it('floors to the containing hour', () => {
    expect(hourWindowStart(MID_WINDOW)).toBe(WINDOW_START);
  });

  it('treats the exact boundary as the start of the new window', () => {
    expect(hourWindowStart(WINDOW_START)).toBe(WINDOW_START);
    expect(nextHourWindowStart(WINDOW_START)).toBe(WINDOW_START + HOUR_MS);
  });

  it('gives a stable, sortable window id', () => {
    expect(hourWindowId(MID_WINDOW)).toBe(hourWindowId(WINDOW_START));
    expect(hourWindowId(MID_WINDOW + HOUR_MS)).toBe(hourWindowId(MID_WINDOW) + 1);
  });

  it('never reports zero milliseconds remaining', () => {
    // A zero would let a job be re-delayed by 0ms and spin against the quota.
    expect(msUntilNextWindow(WINDOW_START + HOUR_MS - 1)).toBe(1);
    expect(msUntilNextWindow(WINDOW_START)).toBe(HOUR_MS);
  });
});

describe('scheduledAtForSeq', () => {
  it('spaces each email by the requested delay', () => {
    expect(scheduledAtForSeq(1000, 0, 5000)).toBe(1000);
    expect(scheduledAtForSeq(1000, 3, 5000)).toBe(16_000);
  });

  it('collapses to the start time when no delay is requested', () => {
    expect(scheduledAtForSeq(1000, 999, 0)).toBe(1000);
  });
});

describe('projectCampaign', () => {
  it('reports nothing to do for an empty campaign', () => {
    const projection = projectCampaign({
      startAt: MID_WINDOW,
      recipientCount: 0,
      delayBetweenMs: 1000,
      hourlyLimit: 10,
    });
    expect(projection).toEqual({
      completesAt: MID_WINDOW,
      windowsRequired: 0,
      throttledByHourlyLimit: false,
    });
  });

  it('is bounded by the per-email delay when the quota is generous', () => {
    const projection = projectCampaign({
      startAt: MID_WINDOW,
      recipientCount: 10,
      delayBetweenMs: 60_000,
      hourlyLimit: 1000,
    });

    expect(projection.completesAt).toBe(MID_WINDOW + 9 * 60_000);
    expect(projection.throttledByHourlyLimit).toBe(false);
  });

  it('spreads 1000 emails across hour windows when the quota is the bottleneck', () => {
    // The assignment's stated load case: 1000+ emails scheduled together.
    const projection = projectCampaign({
      startAt: MID_WINDOW,
      recipientCount: 1000,
      delayBetweenMs: 0,
      hourlyLimit: 200,
    });

    expect(projection.windowsRequired).toBe(5);
    expect(projection.throttledByHourlyLimit).toBe(true);
    // First 200 go immediately; the remaining four batches land in the four
    // following windows, so the last one starts three windows after the next.
    expect(projection.completesAt).toBe(nextHourWindowStart(MID_WINDOW) + 3 * HOUR_MS);
  });

  it('needs a single window when the batch fits inside the quota', () => {
    const projection = projectCampaign({
      startAt: MID_WINDOW,
      recipientCount: 200,
      delayBetweenMs: 0,
      hourlyLimit: 200,
    });

    expect(projection.windowsRequired).toBe(1);
    expect(projection.throttledByHourlyLimit).toBe(false);
  });

  it('takes whichever constraint finishes last', () => {
    // A long delay can outlast the quota schedule even when both apply.
    const projection = projectCampaign({
      startAt: MID_WINDOW,
      recipientCount: 5,
      delayBetweenMs: 2 * HOUR_MS,
      hourlyLimit: 2,
    });

    expect(projection.completesAt).toBe(MID_WINDOW + 4 * 2 * HOUR_MS);
  });
});

describe('rescheduleTarget', () => {
  it('lands at the start of the next window', () => {
    const target = rescheduleTarget({ now: MID_WINDOW, seq: 0, minDelayMs: 2000 });
    expect(target).toBe(nextHourWindowStart(MID_WINDOW));
  });

  it('preserves campaign ordering across the bump', () => {
    // Without the seq offset every deferred job would target the same
    // millisecond and drain in arbitrary order.
    const targets = [0, 1, 2, 3].map((seq) =>
      rescheduleTarget({ now: MID_WINDOW, seq, minDelayMs: 2000 }),
    );

    expect(targets).toEqual([...targets].sort((a, b) => a - b));
    expect(new Set(targets).size).toBe(4);
    expect(targets[1]! - targets[0]!).toBe(2000);
  });

  it('never spills the offset past the window it was aimed at', () => {
    const windowStart = nextHourWindowStart(MID_WINDOW);
    // seq large enough that seq * delay exceeds a full hour.
    const target = rescheduleTarget({ now: MID_WINDOW, seq: 5000, minDelayMs: 2000 });

    expect(target).toBeGreaterThanOrEqual(windowStart);
    expect(target).toBeLessThan(windowStart + HOUR_MS);
  });

  it('collapses to the window start when pacing is disabled', () => {
    expect(rescheduleTarget({ now: MID_WINDOW, seq: 42, minDelayMs: 0 })).toBe(
      nextHourWindowStart(MID_WINDOW),
    );
  });
});
