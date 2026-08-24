import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Usually a `<Button>` — "Compose" from an empty mailbox. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-20 text-center',
        className,
      )}
    >
      {icon && (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-soft text-2xl text-muted">
          {icon}
        </span>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
