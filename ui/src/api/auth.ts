import { apiFetchJson } from './http';

export type UiAuthConfig = { required: boolean };
export type UiAuthSession = { token: string; expiresAt: string };

export const AuthApi = {
  /** Whether the server has a UI password configured at all. */
  config: () => apiFetchJson<UiAuthConfig>('/ui-auth/config'),

  login: (password: string) =>
    apiFetchJson<UiAuthSession>('/ui-auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  /** Confirms a stored token is still signed correctly and unexpired. */
  check: (token: string) =>
    apiFetchJson<{ valid: boolean; required: boolean; expiresAt?: string }>('/ui-auth/session', {
      headers: { Authorization: `Bearer ${token}` },
    }),
};
