'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailJobDetail, ListEmailsResult } from '@reachinbox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';

/** How often the scheduled tab re-checks, so rows visibly move to Sent. */
const SCHEDULED_POLL_MS = 5000;
const SENT_POLL_MS = 15_000;

export interface UseEmailsParams {
  mailbox: 'scheduled' | 'sent';
  search?: string;
  page?: number;
  limit?: number;
}

export function useEmails({ mailbox, search = '', page = 1, limit = 25 }: UseEmailsParams) {
  return useQuery({
    queryKey: queryKeys.emails.list({ mailbox, search, page }),
    queryFn: () => api.emails.list({ mailbox, search, page, limit }),
    // The worker changes this data behind our back, so polling is what makes
    // the dashboard live during a demo. Scheduled moves faster than Sent.
    refetchInterval: mailbox === 'scheduled' ? SCHEDULED_POLL_MS : SENT_POLL_MS,
    // Paging or retyping a search keeps the previous rows on screen rather
    // than collapsing to a skeleton for every keystroke.
    placeholderData: (previous) => previous,
  });
}

export function useEmail(id: string) {
  return useQuery({
    queryKey: queryKeys.emails.detail(id),
    queryFn: () => api.emails.get(id),
    enabled: Boolean(id),
  });
}

export function useCancelEmail() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.emails.cancel(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.detail(id) });
    },
  });
}

/**
 * Starring is optimistic: it is a local flag with no scheduling consequence, so
 * waiting a round-trip to fill in a star would feel broken. The snapshot taken
 * in `onMutate` is restored if the request fails.
 */
export function useStarEmail() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isStarred }: { id: string; isStarred: boolean }) =>
      api.emails.star(id, isStarred),

    onMutate: async ({ id, isStarred }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.emails.all });
      const previous = queryClient.getQueriesData({ queryKey: queryKeys.emails.all });

      queryClient.setQueriesData<ListEmailsResult>(
        { queryKey: ['emails', 'list'] },
        (current) =>
          current && {
            ...current,
            items: current.items.map((item) =>
              item.id === id ? { ...item, isStarred } : item,
            ),
          },
      );
      queryClient.setQueryData<EmailJobDetail>(
        queryKeys.emails.detail(id),
        (current) => current && { ...current, isStarred },
      );

      return { previous };
    },

    onError: (_error, _variables, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all });
    },
  });
}
