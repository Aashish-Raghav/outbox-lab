'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';

/**
 * The `From` picker, plus each sender's live hourly quota usage.
 *
 * Polled because the numbers move as the worker sends; Compose uses them to
 * warn before a campaign is scheduled into a window that is already full.
 */
export function useSenders() {
  return useQuery({
    queryKey: queryKeys.senders,
    queryFn: api.senders.list,
    refetchInterval: 15_000,
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (form: FormData) => api.campaigns.create(form),
    onSuccess: () => {
      // A new campaign changes the scheduled list, the sidebar counts and the
      // senders' projected quota all at once.
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.senders });
      void queryClient.invalidateQueries({ queryKey: queryKeys.campaigns });
    },
  });
}
