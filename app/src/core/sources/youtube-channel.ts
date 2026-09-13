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
 * A YouTube channel's uploads, read from the public per-channel Atom feed.
 *
 * No API key and no quota, which is why this is the default way to follow a
 * channel - youtube-search exists for keyword queries, not for channels.
 *
 * IMPORTANT CAP: this feed returns only the ~15 most recent uploads and offers
 * no paging. A channel that publishes more than 15 videos between two polls
 * silently loses the overflow, so polling cadence has to stay well under the
 * channel's own publishing rate. There is no cursor that can recover the gap -
 * the older entries are simply not in the document.
 */

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";

/** Channel ids are always "UC" plus 22 base64url characters. */
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export const youtubeChannelConfigSchema = z.object({
  /** A bare channel id, or any youtube.com/channel/<id> URL. */
  channelId: z.string().trim().min(1),
  userAgent: z.string().min(1).optional(),
});

export type YoutubeChannelConfig = z.infer<typeof youtubeChannelConfigSchema>;

const parser = new Parser<Record<string, unknown>, Record<string, unknown>>({
  customFields: {
    // The Atom entry carries the bare video id and the description in the
    // YouTube/MediaRSS namespaces, neither of which rss-parser knows about.
    item: [
      ["yt:videoId", "videoId"],
      ["media:group", "mediaGroup"],
      ["published", "publishedRaw"],
    ],
  },
});

/**
 * Accepts what a user is likely to paste. Handles (@name) and /c/ or /user/
 * vanity URLs are deliberately NOT resolved: mapping them to a channel id needs
 * an API call, and this plugin's whole point is working without a key.
 */
export function resolveChannelId(input: string): string | null {
  const trimmed = input.trim();
  if (CHANNEL_ID_PATTERN.test(trimmed)) return trimmed;

  const fromUrl = trimmed.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (fromUrl) return fromUrl[1];

  // Also covers someone pasting the feed URL itself.
  const fromQuery = trimmed.match(/[?&]channel_id=(UC[A-Za-z0-9_-]{22})/);
  if (fromQuery) return fromQuery[1];

  return null;
}

const HANDLE_HELP =
  "A YouTube handle (@name) or vanity URL cannot be resolved without an API key. " +
  "Open the channel, use its .../channel/UC... URL, and paste that channel ID instead.";

export function feedUrlFor(channelId: string): string {
  return `${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`;
}

export const youtubeChannelSource: SourcePlugin<YoutubeChannelConfig> = {
  kind: "source",
  id: "youtube-channel",
  label: "YouTube channel",
  description:
    "New uploads from one channel via its public RSS feed. No API key, no quota; ~15 most recent videos only.",
  configSchema: youtubeChannelConfigSchema,
  capabilities: { pollable: true, supportsCursor: true },

  async validate(config: YoutubeChannelConfig): Promise<ValidationResult> {
    const channelId = resolveChannelId(config.channelId);
    if (!channelId) {
      return { ok: false, message: HANDLE_HELP };
    }

    try {
      const response = await conditionalGet(
        feedUrlFor(channelId),
        null,
        config.userAgent,
      );
      const feed = await parser.parseString(response.body);
      return {
        ok: true,
        message: `Found "${feed.title ?? channelId}" (${feed.items?.length ?? 0} recent videos).`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async fetch(
    config: YoutubeChannelConfig,
    cursor: Cursor | null,
  ): Promise<FetchResult> {
    const channelId = resolveChannelId(config.channelId);
    if (!channelId) throw new Error(HANDLE_HELP);

    const response = await conditionalGet(
      feedUrlFor(channelId),
      cursor,
      config.userAgent,
    );
    if (response.notModified) {
      return { items: [], cursor };
    }

    return { items: await parseVideos(response.body), cursor: response.cursor };
  },
};

async function parseVideos(body: string): Promise<NormalizedItem[]> {
  let feed: Parser.Output<Record<string, unknown>>;
  try {
    feed = await parser.parseString(body);
  } catch {
    return [];
  }

  const fetchedAt = new Date();
  const items: NormalizedItem[] = [];

  for (const entry of feed.items ?? []) {
    const videoId = extractVideoId(entry);
    if (!videoId) continue;

    items.push({
      externalId: videoId,
      // Always the canonical watch URL, never the feed's link: that keeps the
      // URL stable even if YouTube changes how it renders links in the feed.
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: asString(entry.title) ?? "(untitled video)",
      publishedAt:
        parseDate(entry.publishedRaw, entry.isoDate, entry.pubDate) ?? fetchedAt,
      body: mediaDescription(entry.mediaGroup),
      raw: entry,
    });
  }

  return items;
}

function extractVideoId(entry: Record<string, unknown>): string | undefined {
  const direct = asString(entry.videoId);
  if (direct) return direct;

  // Atom <id> is "yt:video:<id>"; the link is the usual watch?v= URL.
  const fromAtomId = asString(entry.id)?.match(/^yt:video:(.+)$/);
  if (fromAtomId) return fromAtomId[1];

  const fromLink = asString(entry.link)?.match(/[?&]v=([A-Za-z0-9_-]+)/);
  if (fromLink) return fromLink[1];

  return undefined;
}

/**
 * media:group is handed over as raw xml2js output, so every level is an array
 * of unknown shape. Descriptions are nice to have, never worth throwing over.
 */
function mediaDescription(group: unknown): string | undefined {
  if (!group || typeof group !== "object") return undefined;
  const description = (group as Record<string, unknown>)["media:description"];
  if (Array.isArray(description)) return asString(description[0]);
  return asString(description);
}

function parseDate(...candidates: unknown[]): Date | null {
  for (const candidate of candidates) {
    const text = asString(candidate);
    if (!text) continue;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}
