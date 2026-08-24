'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Spinner } from '@/components/ui';
import { AlertIcon } from '@/components/icons';
import { Logo } from '@/components/layout/Logo';
import {
  useAuthConfig,
  useCurrentUser,
  useGoogleLogin,
  usePasswordLogin,
} from '@/hooks/useAuth';
import { GoogleButton } from './GoogleButton';

/**
 * The login screen from the Figma: heading, Google button, divider, email and
 * password fields, solid green submit.
 *
 * Which halves are rendered comes from `GET /api/auth/config` rather than a
 * build-time flag, so the page tells the truth about what the running server
 * can actually do — no dead Google button when `GOOGLE_CLIENT_ID` is unset, and
 * no demo form on a deployment that has disabled it.
 */
export function LoginCard() {
  const router = useRouter();
  const config = useAuthConfig();
  const currentUser = useCurrentUser();
  const googleLogin = useGoogleLogin();
  const passwordLogin = usePasswordLogin();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Someone with a live cookie who navigates to /login should not have to log
  // in again just because they typed the URL.
  useEffect(() => {
    if (currentUser.data) router.replace('/scheduled');
  }, [currentUser.data, router]);

  // Prefilling the demo address saves the reviewer a lookup; the password
  // deliberately is not prefilled, since it comes from their own .env.
  useEffect(() => {
    if (config.data?.demoEmail) setEmail((current) => current || config.data.demoEmail!);
  }, [config.data?.demoEmail]);

  const submitError = googleLogin.error ?? passwordLogin.error;
  const busy = googleLogin.isPending || passwordLogin.isPending;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    passwordLogin.mutate({ email, password });
  };

  if (config.isLoading || currentUser.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner className="text-2xl" />
      </div>
    );
  }

  const googleReady = config.data?.googleEnabled && config.data.googleClientId;
  const passwordReady = config.data?.passwordLoginEnabled;

  return (
    <div className="w-full max-w-[420px] rounded-card bg-white p-8 shadow-card">
      <Logo className="mb-8" />

      <h1 className="text-[28px] font-semibold leading-tight text-ink">Login</h1>
      <p className="mt-1.5 text-sm text-muted">
        Sign in to schedule and track your outbound email.
      </p>

      {googleReady && (
        <div className="mt-7">
          <GoogleButton
            clientId={config.data!.googleClientId!}
            loading={googleLogin.isPending}
            onCredential={(credential) => googleLogin.mutate(credential)}
          />
        </div>
      )}

      {googleReady && passwordReady && (
        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs text-muted">or sign up through email</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      )}

      {passwordReady && (
        <form onSubmit={onSubmit} className={googleReady ? '' : 'mt-7'}>
          <div className="space-y-4">
            <Input
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          <Button
            type="submit"
            size="lg"
            fullWidth
            className="mt-6"
            loading={passwordLogin.isPending}
            disabled={busy}
          >
            Login
          </Button>
        </form>
      )}

      {!googleReady && !passwordReady && (
        <div className="mt-7 rounded-field bg-warning-soft p-4 text-sm text-warning">
          <p className="font-medium">No sign-in method is enabled.</p>
          <p className="mt-1">
            Set <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code>, or turn on{' '}
            <code className="font-mono text-xs">ALLOW_PASSWORD_LOGIN</code>, in the API
            environment.
          </p>
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-2 rounded-field bg-danger-soft p-3 text-sm text-danger"
        >
          <AlertIcon className="mt-0.5 shrink-0" />
          <span>{submitError.message}</span>
        </div>
      )}
    </div>
  );
}
