import Parser from "rss-parser";
import { z } from "zod";
import type {
  Cursor,
  FetchResult,
  NormalizedItem,
  SourcePlugin,
  ValidationResult,
} from "../types.js";
import { conditionalGet } from "./feed-http.js";

/**
 * Generic RSS 2.0 / Atom source.
 *
 * We fetch the bytes ourselves instead of letting rss-parser do it, because
 * conditional GET is the whole politeness story here and the parser's own
 * transport gives no access to request or response headers.
 */

export const rssConfigSchema = z.object({
  url: z.string().url(),
  /** Some hosts block the default agent; let the operator override it. */
  userAgent: z.string().min(1).optional(),
});

export type RssConfig = z.infer<typeof rssConfigSchema>;

const parser = new Parser();

export const rssSource: SourcePlugin<RssConfig> = {
  kind: "source",
  id: "rss",
  label: "RSS / Atom feed",
  description:
    "Any RSS or Atom feed. Polled with conditional GET so unchanged feeds cost one 304.",
  configSchema: rssConfigSchema,
  capabilities: { pollable: true, supportsCursor: true },

  async validate(config: RssConfig): Promise<ValidationResult> {
    try {
      // No cursor: a validation run should actually pull and parse the feed.
      const response = await conditionalGet(config.url, null, config.userAgent);
      const feed = await parser.parseString(response.body);
      const count = feed.items?.length ?? 0;
      return {
        ok: true,
        message: `Parsed "${feed.title ?? "untitled feed"}" (${count} items).`,
      };
    } catch (error) {
      return { ok: false, message: describe(error) };
    }
  },

  async fetch(config: RssConfig, cursor: Cursor | null): Promise<FetchResult> {
    const response = await conditionalGet(config.url, cursor, config.userAgent);
    if (response.notModified) {
      return { items: [], cursor };
    }

    const items = await parseItems(response.body);
    return { items, cursor: response.cursor };
  },
};

async function parseItems(body: string): Promise<NormalizedItem[]> {
  let feed: Parser.Output<Record<string, unknown>>;
  try {
    feed = await parser.parseString(body);
  } catch {
    // A feed that is briefly truncated or served as an error page must not kill
    // the poll; the next one will pick up whatever it should have returned.
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
  // guid/id is the publisher's own stable key and survives URL changes, so it
  // beats the link as a dedup key whenever it is present.
  const externalId = firstString(entry.guid, entry.id, entry.link);
  if (!externalId) return null;

  const url = firstString(entry.link, externalId);
  if (!url) return null;

  return {
    externalId,
    url,
    title: firstString(entry.title) ?? "(untitled)",
    publishedAt: parseDate(entry.isoDate, entry.pubDate) ?? fetchedAt,
    body: firstString(entry.contentSnippet, entry.content, entry.summary),
    raw: entry,
  };
}

/**
 * Undated entries fall back to fetch time rather than being dropped: a missing
 * date is a publisher bug, but the item is still real and still filterable.
 */
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
