'use client';

import { useState } from 'react';
import { Button, Popover } from '@/components/ui';
import { CalendarIcon, ClockIcon } from '@/components/icons';
import { cn, formatScheduleChip, toDateTimeLocal } from '@/lib/format';

export interface SendLaterPopoverProps {
  /** `null` means "send as soon as the queue allows". */
  value: Date | null;
  onChange: (value: Date | null) => void;
}

/** The Figma's quick picks, computed relative to when the panel is opened. */
function quickPicks(now: Date): Array<{ label: string; at: Date }> {
  const tomorrowAt = (hour: number, minute = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    date.setHours(hour, minute, 0, 0);
    return date;
  };

  const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);
  inAnHour.setSeconds(0, 0);

  return [
    { label: 'In an hour', at: inAnHour },
    { label: 'Tomorrow, 10:00 AM', at: tomorrowAt(10) },
    { label: 'Tomorrow, 11:00 AM', at: tomorrowAt(11) },
    { label: 'Tomorrow, 3:00 PM', at: tomorrowAt(15) },
  ];
}

/**
 * The clock icon in the Compose header, and the panel behind it.
 *
 * The draft time is held locally and only committed on Done, so Cancel really
 * cancels — clicking through the quick picks does not silently change what will
 * be scheduled.
 */
export function SendLaterPopover({ value, onChange }: SendLaterPopoverProps) {
  const [draft, setDraft] = useState<Date | null>(value);

  return (
    <Popover
      align="right"
      className="w-[300px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            toggle();
          }}
          aria-expanded={open}
          aria-label={value ? `Scheduled for ${formatScheduleChip(value.toISOString())}` : 'Send later'}
          title="Send later"
          className={cn(
            'flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm transition-colors',
            value || open
              ? 'bg-warning-soft text-warning'
              : 'text-muted hover:bg-neutral-soft hover:text-ink',
          )}
        >
          <ClockIcon className="text-lg" />
          {value && (
            <span className="text-xs font-medium">{formatScheduleChip(value.toISOString())}</span>
          )}
        </button>
      )}
    >
      {({ close }) => {
        const now = new Date();

        return (
          <div>
            <p className="mb-3 text-sm font-semibold text-ink">Pick date &amp; time</p>

            <label className="flex items-center gap-2 rounded-field bg-neutral-soft px-3 py-2">
              <CalendarIcon className="shrink-0 text-base text-muted" />
              <input
                type="datetime-local"
                value={draft ? toDateTimeLocal(draft) : ''}
                // A time in the past would just send immediately, which is what
                // the "Send" button is for.
                min={toDateTimeLocal(now)}
                onChange={(event) =>
                  setDraft(event.target.value ? new Date(event.target.value) : null)
                }
                className="w-full bg-transparent text-sm text-ink outline-none"
              />
            </label>

            <div className="mt-3 space-y-1">
              {quickPicks(now).map(({ label, at }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setDraft(at)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-field px-2.5 py-2 text-left text-[13px] transition-colors',
                    draft?.getTime() === at.getTime()
                      ? 'bg-primary-soft text-primary'
                      : 'text-ink hover:bg-neutral-soft',
                  )}
                >
                  <span>{label}</span>
                  <span className="text-xs text-muted">{formatScheduleChip(at.toISOString())}</span>
                </button>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              {value ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    close();
                  }}
                  className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Send immediately
                </button>
              ) : (
                <span />
              )}

              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!draft}
                  onClick={() => {
                    onChange(draft);
                    close();
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        );
      }}
    </Popover>
  );
}
