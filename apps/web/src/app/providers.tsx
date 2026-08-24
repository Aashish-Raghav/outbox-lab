'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { createQueryClient } from '@/lib/queryClient';
import { ToastProvider } from '@/components/ui';

/**
 * Client-side providers, mounted once at the root.
 *
 * The QueryClient is created inside `useState` rather than at module scope: a
 * module-level client is shared by every request the Node server handles, which
 * would leak one visitor's cached mailbox into another's first render.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
