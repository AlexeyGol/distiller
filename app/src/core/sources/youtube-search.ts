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
 * Keyword search over YouTube via Data API v3 `search.list`.
 *
 * QUOTA: search.list costs 100 units against a default 10,000 units/day project
 * quota - 100 polls a day, total, across every source sharing the key. That is
 * the reason for two design choices here:
 *   - the cursor carries publishedAfter, so each poll asks only for what is new
 *     rather than re-reading (and re-paying for) the same window;
 *   - validate() probes videos.list (1 unit) instead of search.list (100), so
 *     pressing "Test" in the UI cannot eat a poll's worth of budget.
 *
 * Quota resets at midnight America/Los_Angeles. We deliberately do not compute
 * a retryAfter from that: guessing the reset wrong would either stall the source
 * for hours or hammer a still-exhausted key, and the worker's own backoff is
 * already the right place for that policy.
 */

const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const PROBE_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

/** search.list caps page size at 50 regardless of what we ask for. */
const MAX_RESULTS_CAP = 50;
const DEFAULT_MAX_RESULTS = 25;

/** First poll window. A new source should report news, not a back catalogue. */
const FIRST_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Google API keys are "AIza" plus 35 more characters. */
const API_KEY_PATTERN = /^AIza[A-Za-z0-9_-]{35}$/;

/** A permanently public video, used as a 1-unit liveness probe for the key. */
const PROBE_VIDEO_ID = "dQw4w9WgXcQ";

export const youtubeSearchConfigSchema = z.object({
  apiKey: z.string().min(1),
  query: z.string().trim().min(1),
  maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).optional(),
  /** ISO 3166-1 alpha-2, e.g. "US". Biases results to one country's catalogue. */
  regionCode: z.string().length(2).optional(),
});

export type YoutubeSearchConfig = z.infer<typeof youtubeSearchConfigSchema>;

export const youtubeSearchSource: SourcePlugin<YoutubeSearchConfig> = {
  kind: "source",
  id: "youtube-search",
  label: "YouTube search",
  description:
    "New videos matching a keyword query, via the YouTube Data API. Costs 100 quota units per poll.",
  configSchema: youtubeSearchConfigSchema,
  capabilities: { pollable: true, supportsCursor: true },

  async validate(config: YoutubeSearchConfig): Promise<ValidationResult> {
    if (!API_KEY_PATTERN.test(config.apiKey)) {
      return {
        ok: false,
        message:
          'That does not look like a Google API key (expected "AIza" followed by 35 characters).',
      };
    }

    const url = new URL(PROBE_ENDPOINT);
    url.searchParams.set("part", "id");
    url.searchParams.set("id", PROBE_VIDEO_ID);
    url.searchParams.set("key", config.apiKey);

    try {
      const payload = await requestJson(url);
      if (!payload || typeof payload !== "object") {
        return { ok: false, message: "Unexpected response from the API." };
      }
      return { ok: true, message: "Key accepted (1 quota unit spent)." };
    } catch (error) {
      if (error instanceof QuotaExhaustedError) {
        return {
          ok: false,
          message: `Key is valid but out of quota: ${error.message}`,
        };
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async fetch(
    config: YoutubeSearchConfig,
    cursor: Cursor | null,
  ): Promise<FetchResult> {
    const publishedAfter =
      cursor?.publishedAfter ??
      new Date(Date.now() - FIRST_POLL_WINDOW_MS).toISOString();

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("order", "date");
    url.searchParams.set("q", config.query);
    url.searchParams.set(
      "maxResults",
      String(config.maxResults ?? DEFAULT_MAX_RESULTS),
    );
    url.searchParams.set("publishedAfter", publishedAfter);
    if (config.regionCode) url.searchParams.set("regionCode", config.regionCode);
    url.searchParams.set("key", config.apiKey);

    const payload = await requestJson(url);
    const items = normalizeSearchItems(payload);

    return {
      items,
      cursor: { publishedAfter: nextPublishedAfter(items, publishedAfter) },
    };
  },
};

/**
 * publishedAfter is inclusive at the boundary, so the newest video comes back
 * once more on the next poll. That is the safe direction to be wrong in: the
 * externalId dedup drops the repeat, whereas nudging the bound forward by a
 * second would silently lose anything published in that same second.
 */
function nextPublishedAfter(
  items: readonly NormalizedItem[],
  fallback: string,
): string {
  let newest = 0;
  for (const item of items) {
    const time = item.publishedAt.getTime();
    if (time > newest) newest = time;
  }
  return newest > 0 ? new Date(newest).toISOString() : fallback;
}

function normalizeSearchItems(payload: unknown): NormalizedItem[] {
  const rows = (payload as { items?: unknown })?.items;
  if (!Array.isArray(rows)) return [];

  const fetchedAt = new Date();
  const items: NormalizedItem[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, any>;

    // type=video should guarantee this, but a channel or playlist hit has no
    // videoId and would otherwise become an item pointing nowhere.
    const videoId = asString(entry.id?.videoId);
    if (!videoId) continue;

    const snippet = (entry.snippet ?? {}) as Record<string, unknown>;

    items.push({
      externalId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      // Snippet titles are HTML-escaped by the API ("&amp;", "&quot;").
      title: decodeEntities(asString(snippet.title) ?? "(untitled video)"),
      publishedAt: parseDate(snippet.publishedAt) ?? fetchedAt,
      body: decodeEntities(asString(snippet.description) ?? "") || undefined,
      raw: entry,
    });
  }

  return items;
}

async function requestJson(url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new TransientError("Network failure calling the YouTube Data API", {
      cause,
    });
  }

  if (response.status >= 500) {
    throw new TransientError(
      `YouTube Data API returned ${response.status}; will retry`,
    );
  }

  const payload = await readJson(response);

  if (response.status === 403) {
    const reason = errorReason(payload);
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      throw new QuotaExhaustedError(
        `YouTube Data API quota exhausted (${reason})`,
      );
    }
    // Any other 403 is a key/permission problem that retrying will not fix.
    throw new Error(
      `YouTube Data API refused the request: ${errorMessage(payload) ?? reason ?? "forbidden"}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `YouTube Data API error ${response.status}: ${errorMessage(payload) ?? "unknown"}`,
    );
  }

  return payload;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // An error page instead of JSON still has to yield a usable status path.
    return null;
  }
}

function errorReason(payload: unknown): string | undefined {
  const errors = (payload as any)?.error?.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const reason = asString(item?.reason);
      if (reason) return reason;
    }
  }
  return asString((payload as any)?.error?.status);
}

function errorMessage(payload: unknown): string | undefined {
  return asString((payload as any)?.error?.message);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match]);
}

function parseDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}
