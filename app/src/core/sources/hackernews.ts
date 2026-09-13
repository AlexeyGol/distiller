import { z } from "zod";
import type {
  Cursor,
  FetchResult,
  NormalizedItem,
  SourcePlugin,
  ValidationResult,
} from "../types.js";
import { QuotaExhaustedError, TransientError } from "../types.js";

/**
 * Keyword-targeted Hacker News via the Algolia HN Search API.
 *
 * Free and keyless, which is why this is the cheap way to watch HN for a term.
 * Two choices worth keeping:
 *   - `search_by_date`, not `search`: relevance ranking would keep re-surfacing
 *     the same well-liked old thread, and a digest wants what is new.
 *   - the cursor carries the newest created_at_i seen and is sent back as a
 *     `created_at_i>N` numeric filter, so each poll asks only for what appeared
 *     since the last one. The first poll defaults to a 24h window so adding a
 *     source does not ingest the entire HN back catalogue.
 */

const SEARCH_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const ITEM_URL_PREFIX = "https://news.ycombinator.com/item?id=";

const DEFAULT_TAGS = "story";
const DEFAULT_HITS_PER_PAGE = 30;
const MAX_HITS_PER_PAGE = 100;

/** First poll window. A new source should report news, not a back catalogue. */
const FIRST_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;

export const hackernewsConfigSchema = z.object({
  query: z.string().trim().min(1),
  /** Algolia tag expression, e.g. "story", "show_hn", "ask_hn". */
  tags: z.string().trim().min(1).optional(),
  /** Adds a points>=N numeric filter; combined with the time cursor. */
  minPoints: z.number().int().min(0).optional(),
  hitsPerPage: z.number().int().min(1).max(MAX_HITS_PER_PAGE).optional(),
});

export type HackernewsConfig = z.infer<typeof hackernewsConfigSchema>;

export const hackernewsSource: SourcePlugin<HackernewsConfig> = {
  kind: "source",
  id: "hackernews",
  label: "Hacker News search",
  description:
    "New Hacker News stories matching a query, via the free Algolia HN Search API. No API key required.",
  configSchema: hackernewsConfigSchema,
  capabilities: { pollable: true, supportsCursor: true },

  async validate(config: HackernewsConfig): Promise<ValidationResult> {
    const url = buildUrl(config, null, 1);
    try {
      const payload = await requestJson(url, null);
      if (payload.notModified || !payload.body) {
        return { ok: true, message: "Search endpoint reachable." };
      }
      const hits = (payload.body as { nbHits?: unknown }).nbHits;
      return {
        ok: true,
        message:
          typeof hits === "number"
            ? `Query matches ${hits} stor${hits === 1 ? "y" : "ies"} on Hacker News.`
            : "Search endpoint reachable.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async fetch(
    config: HackernewsConfig,
    cursor: Cursor | null,
  ): Promise<FetchResult> {
    const since =
      cursor?.publishedAfter ??
      new Date(Date.now() - FIRST_POLL_WINDOW_MS).toISOString();

    const url = buildUrl(config, since, config.hitsPerPage ?? DEFAULT_HITS_PER_PAGE);
    const response = await requestJson(url, cursor);

    // Algolia does serve validators; an unchanged result set costs one 304 and
    // must leave the time cursor exactly where it was.
    if (response.notModified) {
      return { items: [], cursor };
    }

    const items = normalizeHits(response.body);
    const next: Cursor = { publishedAfter: newestCreatedAt(items, since) };
    if (response.etag) next.etag = response.etag;

    return { items, cursor: next };
  },
};

function buildUrl(
  config: HackernewsConfig,
  since: string | null,
  hitsPerPage: number,
): URL {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("query", config.query);
  url.searchParams.set("tags", config.tags ?? DEFAULT_TAGS);
  url.searchParams.set("hitsPerPage", String(hitsPerPage));

  // Algolia takes numericFilters as one comma-separated AND list, so both the
  // points floor and the time cursor have to go into a single parameter.
  const filters: string[] = [];
  if (config.minPoints !== undefined) {
    filters.push(`points>=${config.minPoints}`);
  }
  if (since) {
    const seconds = toUnixSeconds(since);
    // Strictly greater than: the boundary story was already ingested, and the
    // externalId dedup would drop it anyway, so re-fetching it buys nothing.
    if (seconds !== null) filters.push(`created_at_i>${seconds}`);
  }
  if (filters.length > 0) {
    url.searchParams.set("numericFilters", filters.join(","));
  }

  return url;
}

/**
 * The cursor only ever moves forward: an empty poll keeps the previous bound
 * rather than sliding the window and silently skipping a late-indexed story.
 */
function newestCreatedAt(items: readonly NormalizedItem[], fallback: string): string {
  let newest = 0;
  for (const item of items) {
    const time = item.publishedAt.getTime();
    if (time > newest) newest = time;
  }
  if (newest === 0) return fallback;
  const previous = new Date(fallback).getTime();
  return newest > previous ? new Date(newest).toISOString() : fallback;
}

function normalizeHits(payload: unknown): NormalizedItem[] {
  const hits = (payload as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];

  const fetchedAt = new Date();
  const items: NormalizedItem[] = [];

  for (const hit of hits) {
    if (!hit || typeof hit !== "object") continue;
    const entry = hit as Record<string, any>;

    const objectId = asString(entry.objectID);
    if (!objectId) continue;

    // Ask HN, Tell HN and text posts carry url: null - very common, and the
    // discussion page is the real destination for those anyway.
    const url = asString(entry.url) ?? `${ITEM_URL_PREFIX}${objectId}`;

    items.push({
      externalId: objectId,
      url,
      title: asString(entry.title) ?? "(untitled story)",
      publishedAt: parseCreatedAt(entry) ?? fetchedAt,
      body: asString(entry.story_text),
      // points and num_comments ride along in raw so a later feature can
      // filter or rank on them without re-querying Algolia.
      raw: entry,
    });
  }

  return items;
}

interface JsonResponse {
  notModified: boolean;
  body: unknown;
  etag?: string;
}

async function requestJson(url: URL, cursor: Cursor | null): Promise<JsonResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cursor?.etag) headers["if-none-match"] = cursor.etag;

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers });
  } catch (cause) {
    throw new TransientError("Network failure calling the Algolia HN Search API", {
      cause,
    });
  }

  if (response.status === 304) {
    return { notModified: true, body: null };
  }

  if (response.status === 429) {
    throw new QuotaExhaustedError(
      "Algolia HN Search rate limit hit (HTTP 429). Poll this source less often, or narrow the query.",
    );
  }

  if (response.status >= 500) {
    throw new TransientError(
      `Algolia HN Search returned ${response.status}; will retry`,
    );
  }

  if (!response.ok) {
    throw new Error(`Algolia HN Search error ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // An HTML error page instead of JSON is not worth failing a poll over.
    body = null;
  }

  const etag = response.headers.get("etag");
  return { notModified: false, body, etag: etag ?? undefined };
}

function parseCreatedAt(entry: Record<string, unknown>): Date | null {
  const seconds = entry.created_at_i;
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    return new Date(seconds * 1000);
  }
  const text = asString(entry.created_at);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toUnixSeconds(iso: string): number | null {
  const parsed = new Date(iso).getTime();
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}
