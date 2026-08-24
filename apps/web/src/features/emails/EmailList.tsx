'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, IconButton, SearchBar } from '@/components/ui';
import { AlertIcon, ClockIcon, InboxIcon, PlusIcon, RefreshIcon } from '@/components/icons';
import { useEmails } from '@/hooks/useEmails';
import { cn } from '@/lib/format';
import { EmailListSkeleton } from './EmailListSkeleton';
import { EmailRow } from './EmailRow';

export interface EmailListProps {
  mailbox: 'scheduled' | 'sent';
  title: string;
}

const PAGE_SIZE = 25;

/**
 * The Scheduled and Sent screens.
 *
 * Both tabs are this one component with a `mailbox` prop — the rows, the search
 * and the pagination are identical, and the only visual difference (the status
 * chip) is already handled inside the row. Two copies would have drifted the
 * first time either one was touched.
 */
export function EmailList({ mailbox, title }: EmailListProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const query = useEmails({ mailbox, search, page, limit: PAGE_SIZE });

  const items = query.data?.items ?? [];
  const pagination = query.data?.pagination;

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <h1 className="sr-only">{title}</h1>

        <SearchBar
          value={search}
          onChange={(value) => {
            setSearch(value);
            // A search that keeps you on page 4 of the old result set looks
            // empty even when it matched.
            setPage(1);
          }}
          placeholder="Search by recipient or subject"
        />

        <IconButton
          label="Refresh"
          icon={
            <RefreshIcon className={cn(query.isFetching && 'animate-spin')} />
          }
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        />

        <Button
          variant="outline"
          size="sm"
          leftIcon={<PlusIcon className="text-base" />}
          onClick={() => router.push('/compose')}
        >
          Compose
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <EmailListSkeleton />
        ) : query.isError ? (
          <EmptyState
            icon={<AlertIcon />}
            title="Couldn't load this mailbox"
            description={query.error.message}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : items.length === 0 ? (
          // A search that found nothing is a different situation from a mailbox
          // that is genuinely empty, and needs a different way out.
          search ? (
            <EmptyState
              icon={<InboxIcon />}
              title={`No results for “${search}”`}
              description="Try a different recipient address or subject."
              action={
                <Button variant="ghost" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              }
            />
          ) : mailbox === 'scheduled' ? (
            <EmptyState
              icon={<ClockIcon />}
              title="Nothing scheduled"
              description="Emails you schedule will queue up here until their send time."
              action={
                <Button
                  leftIcon={<PlusIcon className="text-base" />}
                  onClick={() => router.push('/compose')}
                >
                  Compose
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<InboxIcon />}
              title="No sent emails yet"
              description="Delivered emails move here automatically, with their Ethereal preview link."
            />
          )
        ) : (
          <ul>
            {items.map((email) => (
              <EmailRow key={email.id} email={email} />
            ))}
          </ul>
        )}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <footer className="flex items-center justify-between border-t border-line px-5 py-3">
          <p className="text-xs text-muted">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total} total
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!pagination.hasNext}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </footer>
      )}
    </>
  );
}
