'use client';

import { useRouter } from 'next/navigation';
import { EMAIL_STATUS, PENDING_STATUSES } from '@reachinbox/shared';
import { Avatar, Button, EmptyState, IconButton, Skeleton, useToast } from '@/components/ui';
import {
  AlertIcon,
  ArrowLeftIcon,
  ArchiveIcon,
  ExternalLinkIcon,
  PaperclipIcon,
  StarIcon,
  TrashIcon,
} from '@/components/icons';
import { useCancelEmail, useEmail, useStarEmail } from '@/hooks/useEmails';
import { formatBytes, formatFullDate, formatRelative, nameFromEmail } from '@/lib/format';
import { StatusChip } from './StatusChip';

export function EmailDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const query = useEmail(id);
  const star = useStarEmail();
  const cancel = useCancelEmail();

  if (query.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <EmptyState
        icon={<AlertIcon />}
        title="Couldn't load this email"
        description={query.error?.message ?? 'It may have been removed.'}
        action={
          <Button variant="outline" onClick={() => router.push('/scheduled')}>
            Back to Scheduled
          </Button>
        }
      />
    );
  }

  const email = query.data;
  const senderName = email.sender?.name ?? 'Unknown sender';
  const senderEmail = email.sender?.fromEmail ?? '';
  const cancellable = PENDING_STATUSES.includes(email.status as never);

  const onCancel = () => {
    cancel.mutate(email.id, {
      onSuccess: () => toast.success('Cancelled', 'This email will not be sent.'),
      onError: (error) => toast.error('Could not cancel', error.message),
    });
  };

  return (
    <>
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <IconButton label="Back" icon={<ArrowLeftIcon />} onClick={() => router.back()} />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
          {email.subject}
        </h1>

        <IconButton
          label={email.isStarred ? 'Unstar' : 'Star'}
          active={email.isStarred}
          icon={<StarIcon filled={email.isStarred} />}
          onClick={() => star.mutate({ id: email.id, isStarred: !email.isStarred })}
        />
        <IconButton label="Archive" icon={<ArchiveIcon />} disabled />
        <IconButton
          label={cancellable ? 'Cancel this email' : 'Already delivered — cannot cancel'}
          icon={<TrashIcon />}
          disabled={!cancellable || cancel.isPending}
          onClick={onCancel}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="flex items-start gap-3">
          <Avatar name={senderName} email={senderEmail} size="lg" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-ink">{senderName}</span>
              {senderEmail && <span className="text-xs text-muted">&lt;{senderEmail}&gt;</span>}
            </div>

            <p className="mt-0.5 text-xs text-muted">
              to {nameFromEmail(email.toEmail)}{' '}
              <span className="text-muted/70">&lt;{email.toEmail}&gt;</span>
            </p>
          </div>

          <div className="shrink-0 text-right">
            <StatusChip email={email} />
            <p className="mt-1.5 text-xs text-muted">
              {email.sentAt
                ? formatFullDate(email.sentAt)
                : `${formatFullDate(email.scheduledAt)} (${formatRelative(email.scheduledAt)})`}
            </p>
          </div>
        </div>

        {/* The audit trail the assignment cares about: why a send moved, and
            where the delivered copy can actually be read. */}
        {(email.rescheduleCount > 0 || email.attempts > 1 || email.lastError) && (
          <dl className="mt-4 space-y-1 rounded-field bg-neutral-soft px-3.5 py-2.5 text-xs">
            {email.rescheduleCount > 0 && (
              <div className="flex gap-2">
                <dt className="text-muted">Rescheduled</dt>
                <dd className="text-warning">
                  {email.rescheduleCount}× — the hourly limit pushed this into a later window
                </dd>
              </div>
            )}
            {email.attempts > 1 && (
              <div className="flex gap-2">
                <dt className="text-muted">Attempts</dt>
                <dd className="text-ink">{email.attempts}</dd>
              </div>
            )}
            {email.lastError && (
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted">Last error</dt>
                <dd className="break-words text-danger">{email.lastError}</dd>
              </div>
            )}
          </dl>
        )}

        {email.status === EMAIL_STATUS.SENT && email.previewUrl && (
          <a
            href={email.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary-softHover"
          >
            <ExternalLinkIcon className="text-sm" />
            {/*
              Not "delivered". Ethereal is a fake SMTP service: it completes the
              handshake, returns a real message id, captures the message in its
              own web inbox and then discards it. Nothing reaches the
              recipient's real mailbox, and calling this "delivered" sends
              people hunting through an inbox that will never contain it.
            */}
            View the captured message on Ethereal
          </a>
        )}

        {/* The body is HTML the user authored and the API sanitised on the way
            in; this renders the same stored value that was mailed out. */}
        <div
          className="rich-text mt-5 border-t border-line pt-5"
          dangerouslySetInnerHTML={{ __html: email.bodyHtml }}
        />

        {email.attachments.length > 0 && (
          <section className="mt-6 border-t border-line pt-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {email.attachments.length}{' '}
              {email.attachments.length === 1 ? 'Attachment' : 'Attachments'}
            </h2>

            <ul className="flex flex-wrap gap-3">
              {email.attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="flex w-[220px] items-center gap-3 rounded-card border border-line p-3"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-field bg-neutral-soft text-base text-muted">
                    <PaperclipIcon />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink">
                      {attachment.filename}
                    </p>
                    <p className="text-xs text-muted">{formatBytes(attachment.size)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
