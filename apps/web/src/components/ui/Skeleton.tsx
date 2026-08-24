import type { CSSProperties } from 'react';
import { cn } from '@/lib/format';

/**
 * A shimmering placeholder block.
 *
 * Used instead of a centered spinner for the email lists: the rows keep their
 * geometry while loading, so the page does not jump when data lands.
 *
 * `style` is accepted for computed widths — Tailwind cannot generate a class
 * for a width that only exists at runtime.
 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn(
        'animate-shimmer rounded bg-[length:400%_100%]',
        'bg-gradient-to-r from-neutral-soft via-neutral-softHover to-neutral-soft',
        className,
      )}
    />
  );
}
