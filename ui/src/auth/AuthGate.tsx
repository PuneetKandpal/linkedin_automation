import { useCallback, useEffect, useState, type PropsWithChildren, type ReactNode } from 'react';
import { AuthApi } from '../api/auth';
import type { ApiError } from '../api/http';
import { Button, Field, InlineError, Loader } from '../components/ui';

const TOKEN_KEY = 'lp-ui-token';
const EXPIRY_KEY = 'lp-ui-token-expires';

export function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    // Drop it locally once expired so we show the login screen without a round trip.
    const expiresAt = window.localStorage.getItem(EXPIRY_KEY);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      clearStoredToken();
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function storeToken(token: string, expiresAt: string) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(EXPIRY_KEY, expiresAt);
  } catch {
    // storage unavailable (private mode) — the session just won't survive a reload
  }
}

export function clearStoredToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(EXPIRY_KEY);
  } catch {
    // ignore
  }
}

type GateState =
  | { phase: 'checking' }
  | { phase: 'locked' }
  /** `required: false` means the server has no UI password set. */
  | { phase: 'open'; required: boolean }
  /** Server unreachable — we cannot tell whether a password is required. */
  | { phase: 'unreachable'; message: string };

/**
 * Password gate around the whole app.
 *
 * The password is verified by the server (never shipped in this bundle) and the
 * resulting session token is kept in localStorage, so a login lasts until the
 * token expires — 90 days — or you sign out.
 */
export function AuthGate(
  props: PropsWithChildren<{
    /** `logout` is undefined when the server has no UI password configured. */
    renderLoggedIn?: (logout: (() => void) | undefined) => ReactNode;
  }>
) {
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const evaluate = useCallback(async () => {
    setState({ phase: 'checking' });
    try {
      const cfg = await AuthApi.config();
      if (!cfg.required) {
        setState({ phase: 'open', required: false });
        return;
      }

      const token = readStoredToken();
      if (!token) {
        setState({ phase: 'locked' });
        return;
      }

      try {
        await AuthApi.check(token);
        setState({ phase: 'open', required: true });
      } catch {
        // Token rejected (expired, or the server password changed).
        clearStoredToken();
        setState({ phase: 'locked' });
      }
    } catch (e) {
      const err = e as ApiError;
      setState({ phase: 'unreachable', message: err.message || 'Could not reach the server' });
    }
  }, []);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  const logout = useCallback(() => {
    clearStoredToken();
    setPassword('');
    setError(null);
    setState({ phase: 'locked' });
  }, []);

  async function submit() {
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await AuthApi.login(password);
      storeToken(session.token, session.expiresAt);
      setPassword('');
      setState({ phase: 'open', required: true });
    } catch (e) {
      setError((e as ApiError).message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (state.phase === 'checking') {
    return (
      <div className="authScreen">
        <Loader label="Checking session…" />
      </div>
    );
  }

  if (state.phase === 'unreachable') {
    return (
      <div className="authScreen">
        <div className="authCard">
          <div className="authTitle">Can't reach the server</div>
          <div className="authSubtitle">{state.message}</div>
          <Button variant="primary" onClick={() => void evaluate()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'locked') {
    return (
      <div className="authScreen">
        <form
          className="authCard"
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="authTitle">LinkedIn Publisher</div>
          <div className="authSubtitle">Enter the password to continue.</div>

          {error ? <InlineError message={error} onClose={() => setError(null)} /> : null}

          <Field label="Password">
            <input
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              placeholder="••••••••"
              onChange={e => setPassword(e.target.value)}
              disabled={submitting}
            />
          </Field>

          <Button type="submit" variant="primary" disabled={submitting || !password.trim()}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>

          <div className="authHint">You'll stay signed in on this browser for 90 days.</div>
        </form>
      </div>
    );
  }

  return <>{props.renderLoggedIn ? props.renderLoggedIn(state.required ? logout : undefined) : props.children}</>;
}
