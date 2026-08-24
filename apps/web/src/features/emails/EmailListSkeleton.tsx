import { Skeleton } from '@/components/ui';

/**
 * Placeholder rows matching the real row's geometry, so nothing shifts when
 * the data lands.
 */
export function EmailListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <ul aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <Skeleton className="h-4 w-[130px]" />
          <Skeleton className="h-5 w-[120px] rounded-full" />
          {/* Varying widths so the block does not read as a striped table. */}
          <Skeleton className="h-4" style={{ width: `${45 + ((index * 13) % 35)}%` }} />
        </li>
      ))}
    </ul>
  );
}
