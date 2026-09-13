import { afterEach, describe, expect, it, vi } from "vitest";
import { TransientError } from "../types.js";
import { rssConfigSchema, rssSource } from "./rss.js";

/** RSS 2.0 shaped like what a real blog feed serves. */
const RSS_2_0 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Simon Willison's Weblog</title>
    <link>https://simonwillison.net/</link>
    <description>Notes on AI and software</description>
    <item>
      <title>Prompt injection is still unsolved</title>
      <link>https://simonwillison.net/2025/Mar/12/prompt-injection/</link>
      <guid isPermaLink="false">tag:simonwillison.net,2025:/2025/Mar/12/prompt-injection</guid>
      <pubDate>Wed, 12 Mar 2025 09:30:00 +0000</pubDate>
      <description>A year on, the problem has not gone away.</description>
    </item>
    <item>
      <title>Notes on local models</title>
      <link>https://simonwillison.net/2025/Mar/10/local-models/</link>
      <pubDate>Mon, 10 Mar 2025 17:05:00 +0000</pubDate>
      <description>Running things on a laptop.</description>
    </item>
  </channel>
</rss>`;

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

describe("rss plugin manifest", () => {
  it("declares the expected identity and capabilities", () => {
    expect(rssSource.id).toBe("rss");
    expect(rssSource.kind).toBe("source");
    expect(rssSource.capabilities).toEqual({
      pollable: true,
      supportsCursor: true,
    });
  });
});

describe("rss config schema", () => {
  it("accepts a valid feed URL", () => {
    const parsed = rssConfigSchema.parse({
      url: "https://example.com/feed.xml",
    });
    expect(parsed.url).toBe("https://example.com/feed.xml");
  });

  it("rejects a non-URL", () => {
    expect(rssConfigSchema.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("rejects a missing url", () => {
    expect(rssConfigSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty userAgent override", () => {
    expect(
      rssConfigSchema.safeParse({
        url: "https://example.com/feed.xml",
        userAgent: "",
      }).success,
    ).toBe(false);
  });
});

describe("rss fetch", () => {
  const config = { url: "https://simonwillison.net/atom/everything/" };

  it("normalizes a well-formed RSS 2.0 feed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(RSS_2_0, {
          headers: {
            etag: '"abc123"',
            "last-modified": "Wed, 12 Mar 2025 09:30:00 GMT",
          },
        }),
      ),
    );

    const result = await rssSource.fetch(config, null);

    expect(result.items).toHaveLength(2);

    const [first, second] = result.items;
    expect(first.externalId).toBe(
      "tag:simonwillison.net,2025:/2025/Mar/12/prompt-injection",
    );
    expect(first.url).toBe(
      "https://simonwillison.net/2025/Mar/12/prompt-injection/",
    );
    expect(first.title).toBe("Prompt injection is still unsolved");
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.publishedAt.toISOString()).toBe("2025-03-12T09:30:00.000Z");
    expect(first.body).toContain("A year on");
    expect(first.raw).toBeTruthy();

    // No guid on the second entry, so the link is the dedup key.
    expect(second.externalId).toBe(
      "https://simonwillison.net/2025/Mar/10/local-models/",
    );

    expect(result.cursor).toEqual({
      etag: '"abc123"',
      lastModified: "Wed, 12 Mar 2025 09:30:00 GMT",
    });
  });

  it("sends no validators on the first poll", async () => {
    const fetchMock = vi.fn(async () => response(RSS_2_0));
    vi.stubGlobal("fetch", fetchMock);

    await rssSource.fetch(config, null);

    const headers = (fetchMock.mock.calls[0] as any)[1].headers as Record<
      string,
      string
    >;
    expect(headers["if-none-match"]).toBeUndefined();
    expect(headers["if-modified-since"]).toBeUndefined();
    expect(headers["user-agent"]).toContain("Distiller");
  });

  it("uses a custom user agent when configured", async () => {
    const fetchMock = vi.fn(async () => response(RSS_2_0));
    vi.stubGlobal("fetch", fetchMock);

    await rssSource.fetch({ ...config, userAgent: "MyBot/1.0" }, null);

    const headers = (fetchMock.mock.calls[0] as any)[1].headers as Record<
      string,
      string
    >;
    expect(headers["user-agent"]).toBe("MyBot/1.0");
  });

  it("round-trips the cursor: validators captured, then sent back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(RSS_2_0, {
          headers: {
            etag: 'W/"v1"',
            "last-modified": "Wed, 12 Mar 2025 09:30:00 GMT",
          },
        }),
      )
      .mockResolvedValueOnce(response("", { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await rssSource.fetch(config, null);
    await rssSource.fetch(config, first.cursor);

    const headers = (fetchMock.mock.calls[1] as any)[1].headers as Record<
      string,
      string
    >;
    expect(headers["if-none-match"]).toBe('W/"v1"');
    expect(headers["if-modified-since"]).toBe("Wed, 12 Mar 2025 09:30:00 GMT");
  });

  it("treats 304 as zero items with the cursor preserved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("", { status: 304 })));

    const cursor = {
      etag: '"abc123"',
      lastModified: "Wed, 12 Mar 2025 09:30:00 GMT",
    };
    const result = await rssSource.fetch(config, cursor);

    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual(cursor);
  });

  it("does not throw on malformed XML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("<rss><channel>")));

    const result = await rssSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });

  it("does not throw on an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("")));

    const result = await rssSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });

  it("returns no items for a valid but empty feed", async () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Nothing</title><link>https://e.com/</link></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => response(empty)));

    const result = await rssSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });

  it("raises TransientError on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("boom", { status: 503 })));

    await expect(rssSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("raises TransientError when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(rssSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("raises a plain error on a 404, which retrying cannot fix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("nope", { status: 404 })));

    const error = await rssSource.fetch(config, null).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
  });
});

describe("rss validate", () => {
  it("reports success with the feed title", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(RSS_2_0)));

    const result = await rssSource.validate!({
      url: "https://simonwillison.net/atom/everything/",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Simon Willison");
  });

  it("reports failure when the feed cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("nope", { status: 404 })));

    const result = await rssSource.validate!({ url: "https://example.com/x" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("404");
  });
});
