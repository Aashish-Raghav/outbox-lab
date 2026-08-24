import { cn } from '@/lib/format';

/** An inline loading indicator sized in `em`, so it tracks the text around it. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-[1em] w-[1em] animate-spin text-muted', className)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      {/* The faint full ring keeps the arc from looking like it is flickering. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
