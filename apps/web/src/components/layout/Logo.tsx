import { cn } from '@/lib/format';

/**
 * The blocky `ONB` wordmark at the top of the sidebar.
 *
 * Drawn as three letter tiles rather than shipped as an asset so it scales
 * cleanly and picks up the theme colour.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1', className)} aria-label="Outbox Labs">
      {['O', 'N', 'B'].map((letter) => (
        <span
          key={letter}
          className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-ink text-[13px] font-bold leading-none text-white"
        >
          {letter}
        </span>
      ))}
    </div>
  );
}
