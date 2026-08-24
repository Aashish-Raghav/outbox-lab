'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';

/** What the login screen is allowed to render, as reported by the server. */
export function useAuthConfig() {
  return useQuery({
    queryKey: queryKeys.auth.config,
    queryFn: api.auth.config,
    // Which auth methods exist changes only when the server restarts.
    staleTime: Infinity,
  });
}

/**
 * The signed-in user, or `null`.
 *
 * A 401 here is the expected answer for a signed-out visitor, not a failure, so
 * it resolves to `null` instead of throwing. That keeps `isError` meaning
 * "something is actually wrong" for callers.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: async () => {
      try {
        const { user } = await api.auth.me();
        return user;
      } catch (error) {
        if (error instanceof ApiRequestError && error.isUnauthorized) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function useGoogleLogin() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: (credential: string) => api.auth.google(credential),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(queryKeys.auth.me, user);
      router.replace('/scheduled');
    },
  });
}

export function usePasswordLogin() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      api.auth.password(email, password),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(queryKeys.auth.me, user);
      router.replace('/scheduled');
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: api.auth.logout,
    // `onSettled`, not `onSuccess`: if the logout request itself fails the user
    // still asked to leave, and the cached mailbox of a previous session must
    // not be left sitting on screen.
    onSettled: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });
}
