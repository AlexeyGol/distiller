import Parser from "rss-parser";
import { z } from "zod";
import type {
  Cursor,
  FetchResult,
  NormalizedItem,
  SourcePlugin,
  ValidationResult,
} from "../types.js";
import { QuotaExhaustedError, TransientError } from "../types.js";
import { conditionalGet, FeedHttpError } from "./feed-http.js";

/**
 * Subreddit posts via Reddit's public Atom endpoints (`/r/<sub>/<sort>.rss`).
 * No API key, no OAuth - but two host rules decide whether this works at all:
 *
 *   1. A DESCRIPTIVE User-Agent is mandatory. Reddit answers a generic agent
 *      (curl, an empty UA, a bare library default) with 429, not 403, so a
 *      missing UA is indistinguishable from rate limiting unless the error
 *      message names both causes. That is why the default UA is a constant
 *      here and why the 429 message spells out both.
 *   2. Since June 2025 the RSS endpoints allow roughly ONE request per minute
 *      per feed, down from 100 per 10 minutes. The default 30-minute poll sits
 *      far inside that; anything that fans out or retries tightly will not.
 *
 * Conditional GET is reused from feed-http, so an unchanged subreddit costs a
 * single 304 and yields zero items with the cursor untouched.
 */

/** Reddit blocks generic agents; this must stay descriptive and contactable. */
const DEFAULT_USER_AGENT =
  "Distiller/0.1 (self-hosted digest; +https://github.com/distiller)";

/** Exported so tests and callers can assert the agent actually sent. */
export const REDDIT_DEFAULT_USER_AGENT = DEFAULT_USER_AGENT;

const SORTS = ["new", "hot", "top", "rising"] as const;
const TIME_RANGES = ["hour", "day", "week", "month", "year", "all"] as const;

const DEFAULT_SORT = "new";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Subreddit names are [A-Za-z0-9_], 2-21 chars; a multi joins them with "+". */
const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{2,21}$/;

export const redditConfigSchema = z.object({
  /**
   * A subreddit, a "a+b" multi, or anything a user is likely to paste: a full
   * URL, "r/foo", "/r/foo". Normalised at request time by normalizeSubreddits.
   */
  subreddits: z
    .string()
    .min(1)
    .refine((value) => normalizeSubreddits(value) !== null, {
      message:
        'Expected a subreddit like "LocalLLaMA", "r/LocalLLaMA", a reddit.com URL, or a multi like "a+b".',
    }),
  sort: z.enum(SORTS).optional(),
  /** Reddit honours this for sort=top only, so it is sent only then. */
  timeRange: z.enum(TIME_RANGES).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  userAgent: z.string().min(1).optional(),
});

export type RedditConfig = z.infer<typeof redditConfigSchema>;

const parser = new Parser();

export const redditSource: SourcePlugin<RedditConfig> = {
  kind: "source",
  id: "reddit",
  label: "Reddit subreddit",
  description:
    "Posts from a subreddit or a multi, via Reddit's public Atom feed. Rate limited to roughly one request per minute per feed.",
  configSchema: redditConfigSchema,
  capabilities: { pollable: true, supportsCursor: true },

  async validate(config: RedditConfig): Promise<ValidationResult> {
    const subreddits = normalizeSubreddits(config.subreddits);
    if (!subreddits) {
      return { ok: false, message: "That is not a usable subreddit name." };
    }

    // This spends one real request against the ~1 req/min budget for this
    // feed, so pressing "Test" right before a poll can make that poll 429.
    const url = buildFeedUrl(config, subreddits, 1);

    try {
      const response = await conditionalGet(url, null, userAgent(config));
      const feed = await parser.parseString(response.body);
      const count = feed.items?.length ?? 0;
      return {
        ok: true,
        message: `r/${subreddits} is reachable (${count} entr${count === 1 ? "y" : "ies"} from a limit=1 probe).`,
      };
    } catch (error) {
      return { ok: false, message: describe(translate(error, subreddits)) };
    }
  },

  async fetch(
    config: RedditConfig,
    cursor: Cursor | null,
  ): Promise<FetchResult> {
    const subreddits = normalizeSubreddits(config.subreddits);
    if (!subreddits) {
      throw new Error(`Unusable subreddit config: "${config.subreddits}"`);
    }

    const url = buildFeedUrl(config, subreddits, config.limit ?? DEFAULT_LIMIT);

    let response: Awaited<ReturnType<typeof conditionalGet>>;
    try {
      response = await conditionalGet(url, cursor, userAgent(config));
    } catch (error) {
      throw translate(error, subreddits);
    }

    // 304 is the steady state for a quiet subreddit: no new items, and the
    // validators we already hold stay authoritative.
    if (response.notModified) {
      return { items: [], cursor };
    }

    return { items: await parseEntries(response.body), cursor: response.cursor };
  },
};

/**
 * Accepts every shape a user is likely to paste and returns the bare "sub" or
 * "a+b" form, or null when nothing usable remains.
 */
export function normalizeSubreddits(input: string): string | null {
  let value = input.trim();
  if (value === "") return null;

  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (!/(^|\.)reddit\.com$/i.test(parsed.hostname)) return null;
    value = parsed.pathname;
  }

  // "/r/foo/new.rss" -> "foo": drop the r/ marker and everything after the
  // subreddit segment, since sort and format come from config, not the URL.
  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments[0]?.toLowerCase() === "r") segments.shift();
  const candidate = segments[0];
  if (!candidate) return null;

  const parts = candidate.replace(/\.rss$/i, "").split("+");
  for (const part of parts) {
    if (!SUBREDDIT_PATTERN.test(part)) return null;
  }

  return parts.join("+");
}

function buildFeedUrl(
  config: RedditConfig,
  subreddits: string,
  limit: number,
): string {
  const sort = config.sort ?? DEFAULT_SORT;
  const url = new URL(`https://www.reddit.com/r/${subreddits}/${sort}.rss`);
  url.searchParams.set("limit", String(limit));
  // Reddit ignores t= for every other sort; sending it regardless just makes
  // the request look wrong to whoever reads the logs next.
  if (sort === "top" && config.timeRange) {
    url.searchParams.set("t", config.timeRange);
  }
  return url.toString();
}

function userAgent(config: RedditConfig): string {
  return config.userAgent ?? DEFAULT_USER_AGENT;
}

/** Maps a transport failure onto what an operator can actually do about it. */
function translate(error: unknown, subreddits: string): unknown {
  if (!(error instanceof FeedHttpError)) return error;

  if (error.status === 429) {
    return new QuotaExhaustedError(
      `Reddit returned 429 for r/${subreddits}. Two different causes look identical here: ` +
        "the RSS endpoints allow roughly one request per minute per feed (tightened in June 2025), " +
        "and Reddit also answers a missing or generic user-agent with 429 - " +
        `send a descriptive User-Agent such as "${DEFAULT_USER_AGENT}".`,
    );
  }

  if (error.status === 403) {
    // Deliberately TRANSIENT, even though 403 normally means "do not retry".
    //
    // Measured against the live endpoint: once the per-minute budget is spent,
    // Reddit returns 403 and 429 interchangeably for the same PUBLIC
    // subreddit. Successive requests for r/LocalLLaMA alternated between 200,
    // 403 and 429 purely as a function of timing, with identical headers.
    //
    // Treating 403 as permanent parks a working source behind a wrong
    // explanation ("private, banned or quarantined") that persists until a
    // human investigates. The asymmetry settles it: if the subreddit really is
    // private, retrying costs one request per poll cycle and lastError keeps
    // saying so. If it is throttling - the common case - retrying is correct.
    return new TransientError(
      `Reddit refused r/${subreddits} (403). Reddit answers with 403 as well as 429 once the ` +
        "roughly one-request-per-minute-per-feed budget is spent, so this is usually throttling " +
        "and clears on the next poll. If it persists across several polls, the subreddit is " +
        "probably private, banned or quarantined.",
    );
  }

  if (error.status === 404) {
    return new Error(`No such subreddit: r/${subreddits} (404).`);
  }

  return error;
}

async function parseEntries(body: string): Promise<NormalizedItem[]> {
  let feed: Parser.Output<Record<string, unknown>>;
  try {
    feed = await parser.parseString(body);
  } catch {
    // A truncated feed or an interstitial HTML page must not fail the poll.
    return [];
  }

  const fetchedAt = new Date();
  const items: NormalizedItem[] = [];

  for (const entry of feed.items ?? []) {
    const normalized = normalizeEntry(entry, fetchedAt);
    if (normalized) items.push(normalized);
  }

  return items;
}

function normalizeEntry(
  entry: Parser.Item & Record<string, unknown>,
  fetchedAt: Date,
): NormalizedItem | null {
  // <id> is the post's fullname (t3_xxxxx). It survives title edits and slug
  // changes, so it is the dedup key; the permalink is only a fallback.
  const externalId = firstString(entry.id, entry.guid, entry.link);
  if (!externalId) return null;

  const url = firstString(entry.link, externalId);
  if (!url) return null;

  return {
    externalId,
    url,
    title: firstString(entry.title) ?? "(untitled post)",
    // rss-parser resolves isoDate from <published> when present and <updated>
    // otherwise, which is exactly the precedence Reddit's Atom needs.
    publishedAt: parseDate(entry.isoDate, entry.pubDate) ?? fetchedAt,
    body: firstString(entry.content, entry.contentSnippet, entry.summary),
    raw: entry,
  };
}

function parseDate(...candidates: unknown[]): Date | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
