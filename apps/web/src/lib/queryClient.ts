import { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from './api';

/**
 * Shared React Query defaults.
 *
 * The important one is the retry policy: the default (3 attempts on everything)
 * turns a 401 on first load into three seconds of spinner before the login
 * redirect, and turns a 400 from a bad form into three identical requests.
 * Only genuinely transient failures are worth retrying.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // The scheduled list changes on its own as the worker drains the queue,
        // so a window refocus should show the truth rather than a cached list.
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError) {
            // 4xx will fail identically however many times we ask.
            if (error.status >= 400 && error.status < 500) return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Query keys in one place.
 *
 * Invalidation is the reason: `queryKeys.emails.all` invalidates both mailbox
 * tabs and every search/page combination in a single call, which is what should
 * happen after a cancel or a new campaign.
 */
export const queryKeys = {
  auth: {
    config: ['auth', 'config'] as const,
    me: ['auth', 'me'] as const,
  },
  senders: ['senders'] as const,
  stats: ['stats'] as const,
  campaigns: ['campaigns'] as const,
  emails: {
    all: ['emails'] as const,
    list: (params: { mailbox: string; search: string; page: number }) =>
      ['emails', 'list', params] as const,
    detail: (id: string) => ['emails', 'detail', id] as const,
  },
} as const;
