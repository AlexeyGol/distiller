/**
 * Single shared password auth.
 *
 * There is a real Google master token behind this app, so an unauthenticated
 * public UI is not acceptable. This is deliberately the smallest thing that is
 * actually real: one shared secret, an HMAC-signed httpOnly cookie, checked in
 * middleware before any page renders.
 *
 * Signing uses WebCrypto rather than node:crypto because middleware may run on
 * the Edge runtime, where node:crypto is unavailable. WebCrypto exists in both.
 */

export const SESSION_COOKIE = "distiller_session";

/** 30 days. Long enough that a self-hosted operator is not retyping it daily. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";

/** Paths that must stay reachable without a session, or login is impossible. */
const PUBLIC_PREFIXES = ["/login", "/_next", "/favicon.ico"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/**
 * The configured password, or undefined when auth is disabled.
 *
 * An unset APP_PASSWORD leaves the UI open. That is a conscious dev-mode
 * escape hatch, not an oversight, and it warns loudly every time it is hit so
 * it cannot quietly become the production configuration.
 */
export function appPassword(
  env: { APP_PASSWORD?: string } = process.env,
): string | undefined {
  const value = env.APP_PASSWORD?.trim();
  return value ? value : undefined;
}

let warned = false;

export function warnIfAuthDisabled(password: string | undefined): void {
  if (password || warned) return;
  warned = true;
  console.warn(
    "[distiller] APP_PASSWORD is not set: the UI is UNAUTHENTICATED. " +
      "Anyone who can reach this port can read your digests and trigger " +
      "renders against your Google account. Set APP_PASSWORD before exposing " +
      "this beyond localhost.",
  );
}

async function hmac(password: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Mint a cookie value. The issue time is in the signed payload, not beside it. */
export async function signSession(
  password: string,
  issuedAt: number = Date.now(),
): Promise<string> {
  const signature = await hmac(password, `${TOKEN_VERSION}.${issuedAt}`);
  return `${TOKEN_VERSION}.${issuedAt}.${signature}`;
}

/** Length-safe, value-independent comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifySession(
  token: string | undefined | null,
  password: string,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<boolean> {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [version, issuedAtRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return false;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;

  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
  if (issuedAt > now + 60_000) return false; // clock skew tolerance, not a future date
  if (now - issuedAt > maxAge) return false;

  const expected = await hmac(password, `${version}.${issuedAtRaw}`);
  return timingSafeEqual(expected, signature!);
}

/**
 * The whole access decision, free of any Next types so it can be unit tested
 * and reused by both the middleware and the login action.
 */
export async function isAuthorized(
  token: string | undefined | null,
  password: string | undefined,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<boolean> {
  if (!password) {
    warnIfAuthDisabled(password);
    return true;
  }
  return verifySession(token, password, options);
}
