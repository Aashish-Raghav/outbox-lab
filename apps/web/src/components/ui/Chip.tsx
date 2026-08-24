'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import { XIcon } from '../icons';

type Tone = 'warning' | 'neutral' | 'primary' | 'danger' | 'muted';

const TONES: Record<Tone, string> = {
  /** The amber `🕐 Tue 9:15:12 AM` schedule chip. */
  warning: 'bg-warning-soft text-warning',
  /** The grey `Sent` chip. */
  neutral: 'bg-neutral-soft text-ink/70',
  /** Green outlined recipient chips in Compose. */
  primary: 'border border-primary bg-white text-primary',
  danger: 'bg-danger-soft text-danger',
  muted: 'bg-neutral-soft text-muted',
};

export interface ChipProps {
  tone?: Tone;
  icon?: ReactNode;
  /** Renders a × that calls this. Omit for a read-only chip. */
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
  children: ReactNode;
}

export function Chip({
  tone = 'neutral',
  icon,
  onRemove,
  removeLabel,
  className,
  children,
}: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full',
        'px-2.5 py-1 text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? 'Remove'}
          className="-mr-0.5 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          <XIcon className="text-[13px]" />
        </button>
      )}
    </span>
  );
}
