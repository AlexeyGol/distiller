import type { Cursor } from "../types.js";
import { TransientError } from "../types.js";

/**
 * Conditional GET for the feed-backed source plugins.
 *
 * Feeds are polled far more often than they change, so every poll carries the
 * validators the server gave us last time. A 304 is the common case and is
 * cheap for both sides - it is a normal outcome, not an error, which is why
 * it gets its own field rather than being signalled by a throw.
 *
 * Validators are stored verbatim in the Cursor: ETags are opaque by spec, and
 * Last-Modified must be echoed back byte-for-byte, so neither may be reformatted.
 */

/** Identifies the poller to feed hosts that rate-limit or block unknown agents. */
const DEFAULT_USER_AGENT = "Distiller/0.1 (+https://github.com/distiller)";

/**
 * A non-retryable 4xx from a feed host. Carries the status so a plugin can give
 * a host-specific diagnosis (Reddit's 429 vs 403 vs 404 mean very different
 * things) without re-implementing the transport or parsing an error string.
 * It stays a plain Error, so callers that only care "this will not fix itself"
 * keep working unchanged.
 */
export class FeedHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FeedHttpError";
    this.status = status;
  }
}

export interface ConditionalGetResult {
  /** True when the server confirmed nothing changed. `body` is then empty. */
  notModified: boolean;
  body: string;
  /** Validators from this response, to send on the next poll. */
  cursor: Cursor;
}

export async function conditionalGet(
  url: string,
  cursor: Cursor | null,
  userAgent?: string,
): Promise<ConditionalGetResult> {
  const headers: Record<string, string> = {
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    "user-agent": userAgent ?? DEFAULT_USER_AGENT,
  };
  if (cursor?.etag) headers["if-none-match"] = cursor.etag;
  if (cursor?.lastModified) headers["if-modified-since"] = cursor.lastModified;

  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch (cause) {
    // DNS/TLS/socket failures are almost always worth another poll later.
    throw new TransientError(`Network failure fetching ${url}`, { cause });
  }

  if (response.status === 304) {
    // A 304 carries no body and may carry no validators; the caller keeps the
    // cursor it already had rather than overwriting it with nothing.
    return { notModified: true, body: "", cursor: cursor ?? {} };
  }

  if (response.status >= 500) {
    throw new TransientError(
      `Upstream error ${response.status} fetching ${url}`,
    );
  }

  if (!response.ok) {
    // 4xx means the feed URL itself is wrong or we are blocked - retrying the
    // identical request will not fix it, so this must not look transient.
    throw new FeedHttpError(
      `Failed to fetch ${url}: HTTP ${response.status}`,
      response.status,
    );
  }

  return {
    notModified: false,
    body: await response.text(),
    cursor: readValidators(response),
  };
}

function readValidators(response: Response): Cursor {
  const cursor: Cursor = {};
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (etag) cursor.etag = etag;
  if (lastModified) cursor.lastModified = lastModified;
  return cursor;
}
