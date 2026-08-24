import type {
  Campaign,
  CreateCampaignResult,
  EmailJobDetail,
  ListEmailsResult,
  SenderQuota,
  Stats,
  User,
} from '@reachinbox/shared';

/**
 * The single place the dashboard talks to the API.
 *
 * Two things are handled here so no component has to think about them:
 * `credentials: 'include'`, because the session is an httpOnly cookie; and
 * unwrapping the `{ data } | { error }` envelope into a value or a thrown
 * `ApiRequestError`, so React Query's `isError` branch is the only error path.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field-level messages from zod, keyed by dotted path. */
  readonly details?: Record<string, string[]>;

  constructor(
    message: string,
    status: number,
    code: string,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the user simply is not signed in, rather than something broken. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      credentials: 'include',
      ...init,
      headers: {
        // Only set for JSON bodies: setting it on a FormData request would
        // clobber the multipart boundary the browser generates.
        ...(init.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init.headers,
      },
    });
  } catch {
    // A network-level failure has no envelope to unwrap, and "Failed to fetch"
    // is not something to show a user.
    throw new ApiRequestError(
      'Could not reach the server. Is the API running on port 4000?',
      0,
      'NETWORK_ERROR',
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { message?: string; code?: string; details?: Record<string, string[]> } })
      ?.error;
    throw new ApiRequestError(
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.details,
    );
  }

  return (payload as { data: T }).data;
}

export interface AuthConfig {
  googleEnabled: boolean;
  googleClientId: string | null;
  passwordLoginEnabled: boolean;
  demoEmail: string | null;
}

export const api = {
  auth: {
    config: () => request<AuthConfig>('/api/auth/config'),
    me: () => request<{ user: User }>('/api/auth/me'),
    google: (credential: string) =>
      request<{ user: User }>('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential }),
      }),
    password: (email: string, password: string) =>
      request<{ user: User }>('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  },

  senders: {
    list: () => request<SenderQuota[]>('/api/senders'),
  },

  campaigns: {
    list: () => request<Campaign[]>('/api/campaigns'),
    // Multipart, because the compose form can carry a lead list and attachments.
    create: (form: FormData) =>
      request<CreateCampaignResult>('/api/campaigns', { method: 'POST', body: form }),
  },

  emails: {
    list: (params: {
      mailbox?: 'scheduled' | 'sent';
      search?: string;
      page?: number;
      limit?: number;
    }) => {
      const query = new URLSearchParams();
      if (params.mailbox) query.set('mailbox', params.mailbox);
      if (params.search) query.set('search', params.search);
      if (params.page) query.set('page', String(params.page));
      if (params.limit) query.set('limit', String(params.limit));
      return request<ListEmailsResult>(`/api/emails?${query.toString()}`);
    },
    get: (id: string) => request<EmailJobDetail>(`/api/emails/${id}`),
    cancel: (id: string) =>
      request<{ id: string; status: string }>(`/api/emails/${id}/cancel`, { method: 'POST' }),
    star: (id: string, isStarred: boolean) =>
      request<{ id: string; isStarred: boolean }>(`/api/emails/${id}/star`, {
        method: 'PATCH',
        body: JSON.stringify({ isStarred }),
      }),
  },

  stats: () => request<Stats>('/api/stats'),
};
