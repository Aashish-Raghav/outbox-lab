'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/format';

export interface PopoverProps {
  /** The control that opens it. Receives the open state so it can look pressed. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  /** Panel contents. `close` lets a Done/Cancel button dismiss the popover. */
  children: (props: { close: () => void }) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/**
 * The "Send Later" panel and the sidebar user menu.
 *
 * Two dismissal paths, because either one alone is a trap: pointerdown outside
 * for mouse users, Escape for keyboard users. `pointerdown` rather than `click`
 * so the panel closes on press instead of waiting for the release — otherwise a
 * click that starts inside and ends outside leaves it open.
 */
export function Popover({ trigger, children, align = 'left', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}

      {open && (
        <div
          role="dialog"
          className={cn(
            'absolute z-40 mt-2 min-w-[240px] animate-fade-in rounded-card',
            'border border-line bg-white p-4 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
