'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';
import { AlertIcon } from '@/components/icons';
import { Sidebar } from '@/components/layout/Sidebar';
import { useCurrentUser } from '@/hooks/useAuth';

/**
 * The persistent dashboard shell, and the client-side auth guard.
 *
 * The session is an httpOnly cookie, so the only way to know whether it is
 * still valid is to ask the API — hence a query rather than a middleware read.
 * Children are never rendered before that answer arrives, so a signed-out
 * visitor never sees a flash of the mailbox before the redirect.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: user, isLoading, isError, error } = useCurrentUser();

  useEffect(() => {
    if (!isLoading && !isError && !user) router.replace('/login');
  }, [isLoading, isError, user, router]);

  if (isLoading || (!user && !isError)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="text-3xl" />
      </div>
    );
  }

  // A network error or a 500 is not a signed-out state; redirecting to /login
  // here would send the user into a loop against a server that is simply down.
  if (isError || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-md rounded-card border border-line p-6 text-center shadow-card">
          <AlertIcon className="mx-auto text-2xl text-danger" />
          <h1 className="mt-3 text-base font-semibold text-ink">Can&apos;t reach the API</h1>
          <p className="mt-1.5 text-sm text-muted">
            {error?.message ?? 'The dashboard could not load your session.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar user={user} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
