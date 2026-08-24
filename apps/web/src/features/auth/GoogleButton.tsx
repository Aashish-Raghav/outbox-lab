'use client';

import { GoogleOAuthProvider } from '@react-oauth/google';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { GoogleIcon } from '@/components/icons';

/**
 * The pale-green "Login with Google" button from the Figma.
 *
 * The backend verifies a Google **ID token** (`verifyIdToken`), which only the
 * Identity Services button or One Tap can produce — `useGoogleLogin`'s OAuth2
 * flow yields an access token instead, and One Tap gets suppressed by the
 * browser after a couple of dismissals. So the real GIS button has to be on the
 * page. It renders in a Google-owned iframe and cannot be restyled, and a
 * synthetic `.click()` on that iframe is ignored by design.
 *
 * The way out is to render the real button transparently *on top of* ours, at
 * the same size: Google receives a genuine user gesture, and what the user sees
 * is the design. The visible button is `aria-hidden` so a screen reader is told
 * about the real control underneath exactly once.
 */

interface GoogleIdentityApi {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (response: { credential?: string }) => void;
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        config: {
          type: 'standard';
          theme: 'outline';
          size: 'large';
          text: 'signin_with';
          shape: 'pill';
          width: number;
        },
      ) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityApi;
  }
}

/** GIS clamps `width` to this; wider containers just leave dead zones. */
const GSI_MAX_WIDTH = 400;

export interface GoogleButtonProps {
  clientId: string;
  onCredential: (credential: string) => void;
  loading?: boolean;
}

function GoogleButtonInner({ clientId, onCredential, loading = false }: GoogleButtonProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  // Kept in a ref so a re-render never re-initializes GIS with a stale closure.
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;

  useEffect(() => {
    const container = overlayRef.current;
    if (!container) return;

    let cancelled = false;

    // GoogleOAuthProvider injects the GIS script, so it is usually not ready
    // on first paint.
    const mount = () => {
      if (cancelled || !window.google || container.childElementCount > 0) return true;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          if (response.credential) callbackRef.current(response.credential);
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        width: Math.min(container.offsetWidth || GSI_MAX_WIDTH, GSI_MAX_WIDTH),
      });
      setReady(true);
      return true;
    };

    if (mount() && window.google) return;

    const poll = setInterval(() => {
      if (window.google) {
        mount();
        clearInterval(poll);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [clientId]);

  return (
    <div className="relative w-full">
      <Button
        variant="soft"
        size="lg"
        fullWidth
        loading={loading}
        // The transparent GIS button above is the real, focusable control.
        aria-hidden="true"
        tabIndex={-1}
        leftIcon={loading ? undefined : <GoogleIcon className="text-lg" />}
      >
        Login with Google
      </Button>

      {/* Transparent, but present and clickable — it is what the user actually
          presses. Hidden entirely while the sign-in request is in flight so a
          second click cannot start a second exchange. */}
      <div
        ref={overlayRef}
        className="absolute inset-0 overflow-hidden opacity-0 [color-scheme:light]"
        style={{ pointerEvents: loading ? 'none' : 'auto' }}
      />

      {!ready && !loading && (
        <p className="mt-2 text-center text-xs text-muted">Loading Google sign-in…</p>
      )}
    </div>
  );
}

export function GoogleButton(props: GoogleButtonProps) {
  return (
    <GoogleOAuthProvider clientId={props.clientId}>
      <GoogleButtonInner {...props} />
    </GoogleOAuthProvider>
  );
}
