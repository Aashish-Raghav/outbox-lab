'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';

/** Drives the `Scheduled 12` / `Sent 785` counts beside the sidebar nav. */
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: api.stats,
    // Matches the scheduled list's poll, so the count and the rows do not
    // disagree with each other on screen.
    refetchInterval: 5000,
  });
}
