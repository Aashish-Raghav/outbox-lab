'use client';

import Link from 'next/link';
import type { EmailJob } from '@reachinbox/shared';
import { StarIcon } from '@/components/icons';
import { useStarEmail } from '@/hooks/useEmails';
import { cn, nameFromEmail } from '@/lib/format';
import { StatusChip } from './StatusChip';

/**
 * One row of the mailbox: `To: John Smith · [chip] · **Subject** - preview ⭐`.
 *
 * The whole row is a link, with the star lifted out as a sibling rather than a
 * nested button — a `<button>` inside an `<a>` is invalid HTML and browsers
 * disagree about which one a click belongs to.
 */
export function EmailRow({ email }: { email: EmailJob }) {
  const star = useStarEmail();

  return (
    <li className="group relative border-b border-line last:border-b-0">
      <Link
        href={`/email/${email.id}`}
        className={cn(
          'flex items-center gap-3 py-3 pl-4 pr-14 transition-colors',
          'hover:bg-neutral-soft/60',
          // Rescheduled rows are worth calling out: it is the hourly limiter
          // doing its job, not a stuck send.
          email.rescheduleCount > 0 && 'bg-warning-soft/30',
        )}
      >
        <span className="w-[150px] shrink-0 truncate text-sm text-ink">
          <span className="text-muted">To: </span>
          {nameFromEmail(email.toEmail)}
        </span>

        <span className="shrink-0">
          <StatusChip email={email} />
        </span>

        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold text-ink">{email.subject}</span>
          {email.preview && <span className="text-muted"> - {email.preview}</span>}
        </span>

        {email.rescheduleCount > 0 && (
          <span
            className="shrink-0 text-[11px] text-warning"
            title="The hourly limit pushed this into a later window"
          >
            ↻ {email.rescheduleCount}
          </span>
        )}
      </Link>

      <button
        type="button"
        onClick={() => star.mutate({ id: email.id, isStarred: !email.isStarred })}
        aria-label={email.isStarred ? 'Unstar this email' : 'Star this email'}
        aria-pressed={email.isStarred}
        className={cn(
          'absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1.5 transition-colors',
          email.isStarred
            ? 'text-warning'
            : 'text-line hover:text-muted group-hover:text-muted',
        )}
      >
        <StarIcon filled={email.isStarred} className="text-base" />
      </button>
    </li>
  );
}
