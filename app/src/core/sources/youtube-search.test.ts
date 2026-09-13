import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaExhaustedError, TransientError } from "../types.js";
import {
  youtubeSearchConfigSchema,
  youtubeSearchSource,
} from "./youtube-search.js";

/** 39 characters: "AIza" plus 35, matching the shape of a real Google API key. */
const API_KEY = "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";

const config = { apiKey: API_KEY, query: "ai safety" };

/** Shaped like a real search.list response. */
const SEARCH_RESPONSE = {
  kind: "youtube#searchListResponse",
  etag: "etag-1",
  regionCode: "US",
  pageInfo: { totalResults: 2, resultsPerPage: 2 },
  items: [
    {
      kind: "youtube#searchResult",
      etag: "etag-item-1",
      id: { kind: "youtube#video", videoId: "aqz-KE-bpKQ" },
      snippet: {
        publishedAt: "2025-03-12T16:00:09Z",
        channelId: "UCXuqSBlHAE6Xw-yeJA0Tunw",
        title: "Interpretability &amp; alignment in 2025",
        description: "A talk on &quot;mechanistic&quot; interpretability.",
        channelTitle: "Some Lab",
        liveBroadcastContent: "none",
      },
    },
    {
      kind: "youtube#searchResult",
      etag: "etag-item-2",
      id: { kind: "youtube#video", videoId: "9bZkp7q19f0" },
      snippet: {
        publishedAt: "2025-03-11T09:15:00Z",
        channelId: "UCabcdefghijklmnopqrstuv",
        title: "Evals are harder than they look",
        description: "Benchmarks, and why they lie.",
        channelTitle: "Another Lab",
        liveBroadcastContent: "none",
      },
    },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  const calls = fetchMock.mock.calls;
  return new URL((calls[calls.length - 1] as any)[0] as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("youtube-search manifest", () => {
  it("declares the expected identity and capabilities", () => {
    expect(youtubeSearchSource.id).toBe("youtube-search");
    expect(youtubeSearchSource.kind).toBe("source");
    expect(youtubeSearchSource.capabilities).toEqual({
      pollable: true,
      supportsCursor: true,
    });
  });
});

describe("youtube-search config schema", () => {
  it("accepts a minimal config", () => {
    const parsed = youtubeSearchConfigSchema.parse(config);
    expect(parsed.query).toBe("ai safety");
    expect(parsed.maxResults).toBeUndefined();
  });

  it("rejects a missing apiKey", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ query: "ai safety" }).success,
    ).toBe(false);
  });

  it("rejects an empty apiKey", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ apiKey: "", query: "x" }).success,
    ).toBe(false);
  });

  it("rejects an empty query", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ apiKey: API_KEY, query: "   " })
        .success,
    ).toBe(false);
  });

  it("rejects maxResults above 50", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ ...config, maxResults: 51 }).success,
    ).toBe(false);
  });

  it("accepts maxResults of exactly 50", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ ...config, maxResults: 50 }).success,
    ).toBe(true);
  });

  it("rejects a non-integer maxResults", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ ...config, maxResults: 12.5 })
        .success,
    ).toBe(false);
  });

  it("rejects a regionCode that is not two characters", () => {
    expect(
      youtubeSearchConfigSchema.safeParse({ ...config, regionCode: "USA" })
        .success,
    ).toBe(false);
  });
});

describe("youtube-search fetch", () => {
  it("normalizes a search.list response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(SEARCH_RESPONSE)));

    const result = await youtubeSearchSource.fetch(config, null);

    expect(result.items).toHaveLength(2);

    const [first] = result.items;
    expect(first.externalId).toBe("aqz-KE-bpKQ");
    expect(first.url).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    // The API escapes snippet text; items must carry readable titles.
    expect(first.title).toBe("Interpretability & alignment in 2025");
    expect(first.body).toBe('A talk on "mechanistic" interpretability.');
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.publishedAt.toISOString()).toBe("2025-03-12T16:00:09.000Z");
    expect(first.raw).toBeTruthy();

    expect(result.items[1].externalId).toBe("9bZkp7q19f0");
  });

  it("sends the documented search parameters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SEARCH_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    await youtubeSearchSource.fetch(
      { ...config, maxResults: 10, regionCode: "GB" },
      null,
    );

    const url = lastUrl(fetchMock);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/youtube/v3/search",
    );
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("order")).toBe("date");
    expect(url.searchParams.get("q")).toBe("ai safety");
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("regionCode")).toBe("GB");
    expect(url.searchParams.get("key")).toBe(API_KEY);
  });

  it("defaults maxResults to 25 and omits regionCode when unset", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SEARCH_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    await youtubeSearchSource.fetch(config, null);

    const url = lastUrl(fetchMock);
    expect(url.searchParams.get("maxResults")).toBe("25");
    expect(url.searchParams.has("regionCode")).toBe(false);
  });

  it("defaults the first poll to a 24h window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-12T18:00:00.000Z"));

    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await youtubeSearchSource.fetch(config, null);

    expect(lastUrl(fetchMock).searchParams.get("publishedAfter")).toBe(
      "2025-03-11T18:00:00.000Z",
    );
  });

  it("uses the cursor's publishedAfter on later polls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await youtubeSearchSource.fetch(config, {
      publishedAfter: "2025-03-12T16:00:09.000Z",
    });

    expect(lastUrl(fetchMock).searchParams.get("publishedAfter")).toBe(
      "2025-03-12T16:00:09.000Z",
    );
  });

  it("advances publishedAfter to the newest item and sends it next time", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(SEARCH_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await youtubeSearchSource.fetch(config, null);
    expect(first.cursor).toEqual({
      publishedAfter: "2025-03-12T16:00:09.000Z",
    });

    await youtubeSearchSource.fetch(config, first.cursor);
    expect(lastUrl(fetchMock).searchParams.get("publishedAfter")).toBe(
      "2025-03-12T16:00:09.000Z",
    );
  });

  it("keeps the existing window when a poll returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: [] })));

    const cursor = { publishedAfter: "2025-03-12T16:00:09.000Z" };
    const result = await youtubeSearchSource.fetch(config, cursor);

    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual(cursor);
  });

  it("skips non-video results that carry no videoId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: { kind: "youtube#channel", channelId: "UCabc" },
              snippet: { publishedAt: "2025-03-12T16:00:09Z", title: "A channel" },
            },
            SEARCH_RESPONSE.items[0],
          ],
        }),
      ),
    );

    const result = await youtubeSearchSource.fetch(config, null);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe("aqz-KE-bpKQ");
  });

  it("does not throw on a response with no items array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ kind: "x" })));

    const result = await youtubeSearchSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });

  it("does not throw when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>nope</html>", { status: 200 })),
    );

    const result = await youtubeSearchSource.fetch(config, null);
    expect(result.items).toEqual([]);
  });
});

describe("youtube-search quota and failure handling", () => {
  it("throws QuotaExhaustedError on 403 quotaExceeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "The request cannot be completed because you have exceeded your quota.",
              errors: [
                {
                  domain: "youtube.quota",
                  reason: "quotaExceeded",
                  message: "The request cannot be completed because you have exceeded your quota.",
                },
              ],
            },
          },
          403,
        ),
      ),
    );

    const error = await youtubeSearchSource.fetch(config, null).catch((e) => e);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error.message).toContain("quotaExceeded");
  });

  it("throws QuotaExhaustedError on 403 dailyLimitExceeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Daily Limit Exceeded",
              errors: [{ domain: "usageLimits", reason: "dailyLimitExceeded" }],
            },
          },
          403,
        ),
      ),
    );

    await expect(youtubeSearchSource.fetch(config, null)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
  });

  it("treats a non-quota 403 as a permanent error, not a quota stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "The request is missing a valid API key.",
              errors: [{ domain: "global", reason: "forbidden" }],
            },
          },
          403,
        ),
      ),
    );

    const error = await youtubeSearchSource.fetch(config, null).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(QuotaExhaustedError);
    expect(error).not.toBeInstanceOf(TransientError);
  });

  it("throws TransientError on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: 500 } }, 500)),
    );

    await expect(youtubeSearchSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("throws TransientError on a 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(youtubeSearchSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("throws TransientError when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    );

    await expect(youtubeSearchSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("throws a plain error on a 400 bad request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: 400, message: "Invalid query" } }, 400),
      ),
    );

    const error = await youtubeSearchSource.fetch(config, null).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
    expect(error.message).toContain("Invalid query");
  });
});

describe("youtube-search validate", () => {
  it("rejects a malformed key without spending any quota", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await youtubeSearchSource.validate!({
      ...config,
      apiKey: "nope",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Google API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes videos.list rather than search.list to keep the cost at 1 unit", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ kind: "youtube#videoListResponse", items: [{ id: "x" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await youtubeSearchSource.validate!(config);

    expect(result.ok).toBe(true);
    const url = lastUrl(fetchMock);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/youtube/v3/videos",
    );
    expect(url.searchParams.get("part")).toBe("id");
  });

  it("reports an exhausted quota as a failed check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
          403,
        ),
      ),
    );

    const result = await youtubeSearchSource.validate!(config);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("quota");
  });
});
