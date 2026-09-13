import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaExhaustedError, TransientError } from "../types.js";
import { hackernewsConfigSchema, hackernewsSource } from "./hackernews.js";

/** Shaped like a real hn.algolia.com/api/v1/search_by_date payload. */
const ALGOLIA_PAYLOAD = {
  hits: [
    {
      created_at: "2025-09-12T09:30:00.000Z",
      title: "Show HN: a local LLM router",
      url: "https://example.com/llm-router",
      author: "someone",
      points: 142,
      story_text: null,
      num_comments: 37,
      objectID: "45123456",
      created_at_i: 1757669400,
      _tags: ["story", "author_someone", "story_45123456"],
    },
    {
      created_at: "2025-09-12T08:00:00.000Z",
      title: "Ask HN: how are you evaluating LLM output?",
      url: null,
      author: "curious",
      points: 12,
      story_text: "We keep shipping regressions and want a sane harness.",
      num_comments: 4,
      objectID: "45123000",
      created_at_i: 1757664000,
      _tags: ["story", "ask_hn"],
    },
  ],
  nbHits: 2,
  page: 0,
  hitsPerPage: 30,
  processingTimeMS: 3,
};

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const body = status === 304 ? null : JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function urlOf(fetchMock: { mock: { calls: any[][] } }, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call][0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hackernews plugin manifest", () => {
  it("declares the expected identity and capabilities", () => {
    expect(hackernewsSource.id).toBe("hackernews");
    expect(hackernewsSource.kind).toBe("source");
    expect(hackernewsSource.capabilities).toEqual({
      pollable: true,
      supportsCursor: true,
    });
  });
});

describe("hackernews config schema", () => {
  it("accepts a bare query", () => {
    expect(hackernewsConfigSchema.parse({ query: "llm" }).query).toBe("llm");
  });

  it("rejects an empty query", () => {
    expect(hackernewsConfigSchema.safeParse({ query: "  " }).success).toBe(false);
    expect(hackernewsConfigSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a hitsPerPage outside 1-100", () => {
    expect(
      hackernewsConfigSchema.safeParse({ query: "llm", hitsPerPage: 0 }).success,
    ).toBe(false);
    expect(
      hackernewsConfigSchema.safeParse({ query: "llm", hitsPerPage: 101 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer minPoints", () => {
    expect(
      hackernewsConfigSchema.safeParse({ query: "llm", minPoints: 12.5 }).success,
    ).toBe(false);
  });
});

describe("hackernews fetch", () => {
  const config = { query: "llm" };

  it("normalizes hits into items", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ALGOLIA_PAYLOAD)));

    const result = await hackernewsSource.fetch(config, null);

    expect(result.items).toHaveLength(2);

    const [first, second] = result.items;
    expect(first.externalId).toBe("45123456");
    expect(first.url).toBe("https://example.com/llm-router");
    expect(first.title).toBe("Show HN: a local LLM router");
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.publishedAt.toISOString()).toBe("2025-09-12T09:30:00.000Z");
    expect(first.body).toBeUndefined();
    expect((first.raw as any).points).toBe(142);
    expect((first.raw as any).num_comments).toBe(37);

    expect(second.body).toContain("sane harness");
  });

  it("falls back to the HN item permalink when a story has no url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ALGOLIA_PAYLOAD)));

    const result = await hackernewsSource.fetch(config, null);

    expect(result.items[1].url).toBe(
      "https://news.ycombinator.com/item?id=45123000",
    );
  });

  it("queries search_by_date, not relevance search", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ALGOLIA_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    await hackernewsSource.fetch({ query: "llm", tags: "show_hn" }, null);

    const url = urlOf(fetchMock);
    expect(url.pathname).toBe("/api/v1/search_by_date");
    expect(url.searchParams.get("query")).toBe("llm");
    expect(url.searchParams.get("tags")).toBe("show_hn");
    expect(url.searchParams.get("hitsPerPage")).toBe("30");
  });

  it("limits the first poll to the last 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-09-13T00:00:00.000Z"));

    const fetchMock = vi.fn(async () => jsonResponse({ hits: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await hackernewsSource.fetch(config, null);

    const filters = urlOf(fetchMock).searchParams.get("numericFilters");
    const expected = Math.floor(Date.parse("2025-09-12T00:00:00.000Z") / 1000);
    expect(filters).toBe(`created_at_i>${expected}`);
  });

  it("advances created_at_i to the newest story seen", async () => {
    // Pinned: the bound only ever moves forward, so the fixture's timestamps
    // have to be newer than the first poll's 24h floor.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-09-12T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ALGOLIA_PAYLOAD)));

    const first = await hackernewsSource.fetch(config, null);
    expect(first.cursor?.publishedAfter).toBe("2025-09-12T09:30:00.000Z");

    const fetchMock = vi.fn(async () => jsonResponse({ hits: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await hackernewsSource.fetch(config, first.cursor);

    expect(urlOf(fetchMock).searchParams.get("numericFilters")).toBe(
      `created_at_i>${1757669400}`,
    );
  });

  it("keeps the previous bound when a poll returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ hits: [] })));

    const cursor = { publishedAfter: "2025-09-12T09:30:00.000Z" };
    const result = await hackernewsSource.fetch(config, cursor);

    expect(result.items).toEqual([]);
    expect(result.cursor?.publishedAfter).toBe("2025-09-12T09:30:00.000Z");
  });

  it("combines minPoints and the time cursor into one numericFilters value", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ALGOLIA_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    await hackernewsSource.fetch(
      { query: "llm", minPoints: 50 },
      { publishedAfter: "2025-09-12T09:30:00.000Z" },
    );

    expect(urlOf(fetchMock).searchParams.get("numericFilters")).toBe(
      `points>=50,created_at_i>${1757669400}`,
    );
  });

  it("treats 304 as zero items with the cursor preserved", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const cursor = {
      publishedAfter: "2025-09-12T09:30:00.000Z",
      etag: 'W/"algolia-v1"',
    };
    const result = await hackernewsSource.fetch(config, cursor);

    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual(cursor);
    expect(
      (fetchMock.mock.calls[0] as any)[1].headers["if-none-match"],
    ).toBe('W/"algolia-v1"');
  });

  it("raises QuotaExhaustedError on a 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 429 })));

    await expect(hackernewsSource.fetch(config, null)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
  });

  it("raises TransientError on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 502 })));

    await expect(hackernewsSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("raises TransientError when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );

    await expect(hackernewsSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("does not throw on a malformed or empty payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>oops</html>", { status: 200 })),
    );
    expect((await hackernewsSource.fetch(config, null)).items).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ hits: "nope" })));
    expect((await hackernewsSource.fetch(config, null)).items).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    expect((await hackernewsSource.fetch(config, null)).items).toEqual([]);
  });

  it("skips hits with no objectID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ hits: [{ title: "orphan", created_at_i: 1757669400 }] }),
      ),
    );

    expect((await hackernewsSource.fetch(config, null)).items).toEqual([]);
  });
});

describe("hackernews validate", () => {
  it("reports the match count from a one-hit probe", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ALGOLIA_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    const result = await hackernewsSource.validate!({ query: "llm" });

    expect(result.ok).toBe(true);
    expect(urlOf(fetchMock).searchParams.get("hitsPerPage")).toBe("1");
    expect(result.message).toContain("2");
  });

  it("reports failure when the API refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 400 })));

    const result = await hackernewsSource.validate!({ query: "llm" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("400");
  });
});
