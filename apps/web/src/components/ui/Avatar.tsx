'use client';

import { useState } from 'react';
import { cn, initials } from '@/lib/format';

const SIZES = {
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
} as const;

export interface AvatarProps {
  name: string;
  email?: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * Google profile pictures 404 fairly often once a token ages, and a broken
 * image icon in the sidebar looks like a bug — so a failed load falls back to
 * initials rather than leaving the element empty.
 */
export function Avatar({ name, email, src, size = 'md', className }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full',
        'bg-primary-soft font-semibold uppercase text-primary',
        SIZES[size],
        className,
      )}
      title={email ?? name}
    >
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote avatar
        // hosts are user-controlled; next/image would need every one allow-listed.
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name, email)
      )}
    </span>
  );
}
