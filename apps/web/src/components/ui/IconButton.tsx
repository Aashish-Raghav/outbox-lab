'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/format';

const SIZES = {
  sm: 'h-7 w-7 text-[15px]',
  md: 'h-9 w-9 text-lg',
  lg: 'h-10 w-10 text-xl',
} as const;

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control is invisible to a screen reader without it. */
  label: string;
  size?: keyof typeof SIZES;
  /** Green-on-pale-green, for a toggled-on state. */
  active?: boolean;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', active = false, icon, className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'bg-primary-soft text-primary'
          : 'text-muted hover:bg-neutral-soft hover:text-ink',
        SIZES[size],
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});
