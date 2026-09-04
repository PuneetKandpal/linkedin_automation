import crypto from 'crypto';

/**
 * Password gate for the web UI only.
 *
 * This protects the browser app from casual access; it deliberately does NOT
 * touch the data API or the publishing pipeline, so the worker, Postman
 * collections and bulk-upload scripts keep working exactly as before.
 *
 * The gate is inert until UI_PASSWORD is set, which keeps existing deployments
 * (and local development) working without extra configuration.
 */

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function isUiAuthEnabled(): boolean {
  return Boolean((process.env.UI_PASSWORD || '').trim());
}

function signingKey(): string {
  // An explicit secret keeps sessions alive across a password change; without
  // one we derive from the password, so rotating it logs everybody out.
  const explicit = (process.env.UI_AUTH_SECRET || '').trim();
  if (explicit) return explicit;
  return `derived:${(process.env.UI_PASSWORD || '').trim()}`;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyPassword(candidate: unknown): boolean {
  const expected = (process.env.UI_PASSWORD || '').trim();
  if (!expected) return false;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return safeEqual(candidate, expected);
}

export type UiSessionToken = {
  token: string;
  expiresAt: string;
};

export function issueToken(): UiSessionToken {
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: expiresAtMs })).toString('base64url');
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export type UiSessionCheck =
  | { valid: true; expiresAt: string }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyToken(token: unknown): UiSessionCheck {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'malformed' };
  }

  const [payload, signature] = token.split('.', 2);
  if (!payload || !signature) return { valid: false, reason: 'malformed' };

  if (!safeEqual(signature, sign(payload))) {
    return { valid: false, reason: 'bad_signature' };
  }

  let exp: unknown;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    exp = decoded.exp;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { valid: false, reason: 'malformed' };
  }
  if (Date.now() >= exp) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, expiresAt: new Date(exp).toISOString() };
}

/**
 * Small in-memory throttle so the password cannot be brute-forced over HTTP.
 * Per-process state is fine here: it only needs to slow an attacker down, and a
 * restart costs them the attempts they had already burned anyway.
 */
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map<string, { count: number; firstAt: number }>();

export function loginBlockedFor(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  const elapsed = Date.now() - entry.firstAt;
  if (elapsed >= ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return 0;
  }
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((ATTEMPT_WINDOW_MS - elapsed) / 1000);
}

export function recordFailedLogin(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt >= ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearFailedLogins(key: string): void {
  attempts.delete(key);
}

/** Reads the bearer token off a request's Authorization header. */
export function bearerFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
