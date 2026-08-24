import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, letting a caller's utility win over a component default.
 *
 * Plain concatenation would emit `px-4 px-2` and leave the winner to CSS source
 * order, which is not something a component author can reason about.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `Tue 9:15:12 AM` — the amber scheduled chip in the Figma. */
export function formatScheduleChip(iso: string): string {
  const date = new Date(iso);
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${weekday} ${time}`;
}

/**
 * `9:15 AM` for today, `Aug 24` for this year, `Aug 24, 2025` beyond it.
 *
 * Mail clients drop the parts you can infer, which is why a list of today's
 * messages reads as a column of times rather than a column of identical dates.
 */
export function formatListDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `Aug 24, 2026, 9:15 AM` — the detail-view header. */
export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `in 4 minutes` / `2 hours ago`, for the countdown on a scheduled row. */
export function formatRelative(iso: string): string {
  const deltaMs = new Date(iso).getTime() - Date.now();
  const absolute = Math.abs(deltaMs);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
  ];

  // Largest unit that still yields a number a person would say out loud.
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let size = 1000;
  for (const [candidate, candidateSize] of units) {
    if (absolute >= candidateSize) {
      unit = candidate;
      size = candidateSize;
    }
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return formatter.format(Math.round(deltaMs / size), unit);
}

/** `1.2 MB` — attachment cards in the detail view. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/** The initials shown in an avatar when there is no picture. */
export function initials(name: string, email?: string): string {
  const source = name.trim() || email?.trim() || '?';
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

/** Turns an address into a display name when we have nothing better. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Formats a `<input type="datetime-local">` value from a Date.
 *
 * `toISOString()` is UTC, which would silently shift the time a user picked;
 * this keeps their local wall clock.
 */
export function toDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
