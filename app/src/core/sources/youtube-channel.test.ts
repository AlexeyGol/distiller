import { afterEach, describe, expect, it, vi } from "vitest";
import {
  feedUrlFor,
  resolveChannelId,
  youtubeChannelConfigSchema,
  youtubeChannelSource,
} from "./youtube-channel.js";

const CHANNEL_ID = "UCXuqSBlHAE6Xw-yeJA0Tunw";

/** Shaped like a real youtube.com/feeds/videos.xml document. */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <link rel="alternate" href="https://www.youtube.com/channel/${CHANNEL_ID}"/>
  <id>yt:channel:${CHANNEL_ID}</id>
  <yt:channelId>${CHANNEL_ID}</yt:channelId>
  <title>Linus Tech Tips</title>
  <published>2008-11-25T01:52:15+00:00</published>
  <entry>
    <id>yt:video:aqz-KE-bpKQ</id>
    <yt:videoId>aqz-KE-bpKQ</yt:videoId>
    <yt:channelId>${CHANNEL_ID}</yt:channelId>
    <title>We built the fastest PC ever</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=aqz-KE-bpKQ"/>
    <published>2025-03-12T16:00:09+00:00</published>
    <updated>2025-03-13T02:11:40+00:00</updated>
    <media:group>
      <media:title>We built the fastest PC ever</media:title>
      <media:content url="https://www.youtube.com/v/aqz-KE-bpKQ?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
      <media:description>It took three weeks and far too much money.</media:description>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:9bZkp7q19f0</id>
    <yt:videoId>9bZkp7q19f0</yt:videoId>
    <title>Cheap gear that is actually good</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=9bZkp7q19f0"/>
    <published>2025-03-10T15:30:00+00:00</published>
    <updated>2025-03-10T15:30:00+00:00</updated>
    <media:group>
      <media:title>Cheap gear that is actually good</media:title>
      <media:description>Budget picks.</media:description>
    </media:group>
  </entry>
</feed>`;

function response(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(init.status === 304 ? null : body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("youtube-channel manifest", () => {
  it("declares the expected identity and capabilities", () => {
    expect(youtubeChannelSource.id).toBe("youtube-channel");
    expect(youtubeChannelSource.kind).toBe("source");
    expect(youtubeChannelSource.capabilities).toEqual({
      pollable: true,
      supportsCursor: true,
    });
  });
});

describe("resolveChannelId", () => {
  it("accepts a bare channel id", () => {
    expect(resolveChannelId(CHANNEL_ID)).toBe(CHANNEL_ID);
  });

  it("extracts the id from a full channel URL", () => {
    expect(
      resolveChannelId(`https://www.youtube.com/channel/${CHANNEL_ID}`),
    ).toBe(CHANNEL_ID);
  });

  it("extracts the id from a channel URL with a trailing path", () => {
    expect(
      resolveChannelId(`https://www.youtube.com/channel/${CHANNEL_ID}/videos`),
    ).toBe(CHANNEL_ID);
  });

  it("extracts the id from a pasted feed URL", () => {
    expect(resolveChannelId(feedUrlFor(CHANNEL_ID))).toBe(CHANNEL_ID);
  });

  it("returns null for a bare handle", () => {
    expect(resolveChannelId("@LinusTechTips")).toBeNull();
  });

  it("returns null for a handle URL", () => {
    expect(resolveChannelId("https://www.youtube.com/@LinusTechTips")).toBeNull();
  });

  it("returns null for a /c/ vanity URL", () => {
    expect(
      resolveChannelId("https://www.youtube.com/c/LinusTechTips"),
    ).toBeNull();
  });
});

describe("youtube-channel config schema", () => {
  it("accepts a full channel URL", () => {
    const parsed = youtubeChannelConfigSchema.parse({
      channelId: `https://www.youtube.com/channel/${CHANNEL_ID}`,
    });
    expect(parsed.channelId).toBe(
      `https://www.youtube.com/channel/${CHANNEL_ID}`,
    );
  });

  it("rejects an empty channelId", () => {
    expect(
      youtubeChannelConfigSchema.safeParse({ channelId: "   " }).success,
    ).toBe(false);
  });

  it("rejects a missing channelId", () => {
    expect(youtubeChannelConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe("youtube-channel validate", () => {
  it("rejects a bare @handle with an explanatory message", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await youtubeChannelSource.validate!({
      channelId: "@LinusTechTips",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("channel ID");
    // Nothing is worth a network round trip when the id cannot be resolved.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a full channel URL and probes the feed", async () => {
    const fetchMock = vi.fn(async () => response(ATOM));
    vi.stubGlobal("fetch", fetchMock);

    const result = await youtubeChannelSource.validate!({
      channelId: `https://www.youtube.com/channel/${CHANNEL_ID}/videos`,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Linus Tech Tips");
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(feedUrlFor(CHANNEL_ID));
  });
});

describe("youtube-channel fetch", () => {
  const config = { channelId: CHANNEL_ID };

  it("normalizes the uploads feed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(ATOM, { headers: { etag: '"yt-1"' } })),
    );

    const result = await youtubeChannelSource.fetch(config, null);

    expect(result.items).toHaveLength(2);

    const [first] = result.items;
    expect(first.externalId).toBe("aqz-KE-bpKQ");
    expect(first.url).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    expect(first.title).toBe("We built the fastest PC ever");
    expect(first.publishedAt).toBeInstanceOf(Date);
    // published, not updated - an edit must not re-date the video.
    expect(first.publishedAt.toISOString()).toBe("2025-03-12T16:00:09.000Z");
    expect(first.body).toContain("three weeks");

    expect(result.items[1].externalId).toBe("9bZkp7q19f0");
    expect(result.cursor).toEqual({ etag: '"yt-1"' });
  });

  it("requests the public channel feed URL", async () => {
    const fetchMock = vi.fn(async () => response(ATOM));
    vi.stubGlobal("fetch", fetchMock);

    await youtubeChannelSource.fetch(config, null);

    expect((fetchMock.mock.calls[0] as any)[0]).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    );
  });

  it("treats 304 as zero items with the cursor preserved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("", { status: 304 })));

    const cursor = { etag: '"yt-1"' };
    const result = await youtubeChannelSource.fetch(config, cursor);

    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual(cursor);
  });

  it("round-trips the cursor onto the next request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(ATOM, {
          headers: {
            etag: '"yt-1"',
            "last-modified": "Thu, 13 Mar 2025 02:11:40 GMT",
          },
        }),
      )
      .mockResolvedValueOnce(response("", { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await youtubeChannelSource.fetch(config, null);
    const second = await youtubeChannelSource.fetch(config, first.cursor);

    const headers = (fetchMock.mock.calls[1] as any)[1].headers as Record<
      string,
      string
    >;
    expect(headers["if-none-match"]).toBe('"yt-1"');
    expect(headers["if-modified-since"]).toBe("Thu, 13 Mar 2025 02:11:40 GMT");
    expect(second.items).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("rejects a handle at fetch time rather than guessing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      youtubeChannelSource.fetch({ channelId: "@LinusTechTips" }, null),
    ).rejects.toThrow(/channel ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw on malformed XML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("<feed><entry>")));

    const result = await youtubeChannelSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });

  it("does not throw on an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("")));

    const result = await youtubeChannelSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });

  it("skips entries with no resolvable video id", async () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Broken</title>
  <entry>
    <id>tag:example.com,2025:nonsense</id>
    <title>No video id anywhere</title>
    <link rel="alternate" href="https://example.com/page"/>
    <published>2025-03-12T16:00:09+00:00</published>
  </entry>
</feed>`;
    vi.stubGlobal("fetch", vi.fn(async () => response(feed)));

    const result = await youtubeChannelSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });
});
