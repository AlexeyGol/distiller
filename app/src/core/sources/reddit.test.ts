import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaExhaustedError, TransientError } from "../types.js";
import {
  normalizeSubreddits,
  redditConfigSchema,
  redditSource,
  REDDIT_DEFAULT_USER_AGENT,
} from "./reddit.js";

/** Shaped like what https://www.reddit.com/r/LocalLLaMA/new.rss actually serves. */
const REDDIT_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <category term="LocalLLaMA" label="r/LocalLLaMA"/>
  <updated>2025-09-12T10:00:00+00:00</updated>
  <icon>https://www.redditstatic.com/icon.png</icon>
  <id>/r/LocalLLaMA/new/.rss</id>
  <link rel="self" href="https://www.reddit.com/r/LocalLLaMA/new.rss" type="application/atom+xml"/>
  <title>Local LLaMA</title>
  <entry>
    <author><name>/u/quant_hobbyist</name><uri>https://www.reddit.com/user/quant_hobbyist</uri></author>
    <category term="LocalLLaMA" label="r/LocalLLaMA"/>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Benchmarks on a single 3090.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>
    <id>t3_1weufjc</id>
    <link href="https://www.reddit.com/r/LocalLLaMA/comments/1weufjc/qwen3_on_a_3090/" />
    <updated>2025-09-12T09:40:00+00:00</updated>
    <published>2025-09-12T09:30:00+00:00</published>
    <title>Qwen3 on a 3090</title>
  </entry>
  <entry>
    <author><name>/u/someone_else</name><uri>https://www.reddit.com/user/someone_else</uri></author>
    <category term="MachineLearning" label="r/MachineLearning"/>
    <id>t3_1wef001</id>
    <link href="https://www.reddit.com/r/MachineLearning/comments/1wef001/paper_thread/" />
    <updated>2025-09-12T08:00:00+00:00</updated>
    <title>[R] A paper thread</title>
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

function headersOf(fetchMock: { mock: { calls: any[][] } }, call = 0) {
  return fetchMock.mock.calls[call][1].headers as Record<string, string>;
}

function urlOf(fetchMock: { mock: { calls: any[][] } }, call = 0): string {
  return String(fetchMock.mock.calls[call][0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reddit plugin manifest", () => {
  it("declares the expected identity and capabilities", () => {
    expect(redditSource.id).toBe("reddit");
    expect(redditSource.kind).toBe("source");
    expect(redditSource.capabilities).toEqual({
      pollable: true,
      supportsCursor: true,
    });
  });
});

describe("reddit subreddit normalisation", () => {
  const table: Array<[string, string]> = [
    ["https://www.reddit.com/r/foo/", "foo"],
    ["https://www.reddit.com/r/foo", "foo"],
    ["https://old.reddit.com/r/foo/new.rss", "foo"],
    ["https://www.reddit.com/r/LocalLLaMA+MachineLearning/new.rss", "LocalLLaMA+MachineLearning"],
    ["r/foo", "foo"],
    ["/r/foo", "foo"],
    ["foo", "foo"],
    ["  foo  ", "foo"],
    ["LocalLLaMA+MachineLearning", "LocalLLaMA+MachineLearning"],
  ];

  for (const [input, expected] of table) {
    it(`normalizes ${JSON.stringify(input)} to ${expected}`, () => {
      expect(normalizeSubreddits(input)).toBe(expected);
    });
  }

  const rejected = [
    "",
    "   ",
    "foo bar",
    "r/",
    "/r/",
    "foo+",
    "+foo",
    "foo!",
    "https://example.com/r/foo",
    "a".repeat(22),
  ];

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(normalizeSubreddits(input)).toBeNull();
    });
  }
});

describe("reddit config schema", () => {
  it("accepts a bare subreddit", () => {
    expect(redditConfigSchema.safeParse({ subreddits: "LocalLLaMA" }).success).toBe(
      true,
    );
  });

  it("accepts a full URL, a sort and a time range", () => {
    const parsed = redditConfigSchema.parse({
      subreddits: "https://www.reddit.com/r/LocalLLaMA/",
      sort: "top",
      timeRange: "week",
      limit: 50,
    });
    expect(parsed.sort).toBe("top");
    expect(parsed.timeRange).toBe("week");
  });

  it("rejects whitespace inside a subreddit name", () => {
    expect(
      redditConfigSchema.safeParse({ subreddits: "Local LLaMA" }).success,
    ).toBe(false);
  });

  it("rejects an empty subreddit", () => {
    expect(redditConfigSchema.safeParse({ subreddits: "" }).success).toBe(false);
  });

  it("rejects an unknown sort", () => {
    expect(
      redditConfigSchema.safeParse({ subreddits: "foo", sort: "controversial" })
        .success,
    ).toBe(false);
  });

  it("rejects a limit outside 1-100", () => {
    expect(
      redditConfigSchema.safeParse({ subreddits: "foo", limit: 0 }).success,
    ).toBe(false);
    expect(
      redditConfigSchema.safeParse({ subreddits: "foo", limit: 101 }).success,
    ).toBe(false);
  });

  it("rejects an empty userAgent override", () => {
    expect(
      redditConfigSchema.safeParse({ subreddits: "foo", userAgent: "" }).success,
    ).toBe(false);
  });
});

describe("reddit fetch", () => {
  const config = { subreddits: "LocalLLaMA" };

  it("normalizes the Atom feed into items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(REDDIT_ATOM, { headers: { etag: 'W/"reddit-v1"' } }),
      ),
    );

    const result = await redditSource.fetch(config, null);

    expect(result.items).toHaveLength(2);

    const [first, second] = result.items;
    expect(first.externalId).toBe("t3_1weufjc");
    expect(first.url).toBe(
      "https://www.reddit.com/r/LocalLLaMA/comments/1weufjc/qwen3_on_a_3090/",
    );
    expect(first.title).toBe("Qwen3 on a 3090");
    expect(first.publishedAt).toBeInstanceOf(Date);
    // <published> wins over <updated> when both are there.
    expect(first.publishedAt.toISOString()).toBe("2025-09-12T09:30:00.000Z");
    expect(first.body).toContain("Benchmarks on a single 3090");

    // Second entry has only <updated>, which must still produce a real date.
    expect(second.externalId).toBe("t3_1wef001");
    expect(second.publishedAt.toISOString()).toBe("2025-09-12T08:00:00.000Z");

    expect(result.cursor).toEqual({ etag: 'W/"reddit-v1"' });
  });

  it("never sends a generic user agent", async () => {
    const fetchMock = vi.fn(async () => response(REDDIT_ATOM));
    vi.stubGlobal("fetch", fetchMock);

    await redditSource.fetch(config, null);

    const agent = headersOf(fetchMock)["user-agent"];
    expect(agent).toBe(REDDIT_DEFAULT_USER_AGENT);
    // Reddit 429s anything that does not identify itself, so the default has
    // to be descriptive, not just non-empty.
    expect(agent).toContain("Distiller");
    expect(agent).toContain("+https://");
    expect(agent.length).toBeGreaterThan(20);
  });

  it("lets the operator override the user agent", async () => {
    const fetchMock = vi.fn(async () => response(REDDIT_ATOM));
    vi.stubGlobal("fetch", fetchMock);

    await redditSource.fetch({ ...config, userAgent: "MyDigest/2.0 (+me)" }, null);

    expect(headersOf(fetchMock)["user-agent"]).toBe("MyDigest/2.0 (+me)");
  });

  it("requests the configured sort and limit", async () => {
    const fetchMock = vi.fn(async () => response(REDDIT_ATOM));
    vi.stubGlobal("fetch", fetchMock);

    await redditSource.fetch({ subreddits: "r/LocalLLaMA", sort: "hot", limit: 10 }, null);

    expect(urlOf(fetchMock)).toBe(
      "https://www.reddit.com/r/LocalLLaMA/hot.rss?limit=10",
    );
  });

  it("sends t= only when the sort is top", async () => {
    const fetchMock = vi.fn(async () => response(REDDIT_ATOM));
    vi.stubGlobal("fetch", fetchMock);

    await redditSource.fetch(
      { subreddits: "LocalLLaMA", sort: "top", timeRange: "week" },
      null,
    );
    await redditSource.fetch(
      { subreddits: "LocalLLaMA", sort: "new", timeRange: "week" },
      null,
    );

    expect(urlOf(fetchMock, 0)).toContain("t=week");
    expect(urlOf(fetchMock, 1)).not.toContain("t=week");
  });

  it("treats 304 as zero items with the cursor preserved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("", { status: 304 })));

    const cursor = { etag: 'W/"reddit-v1"' };
    const result = await redditSource.fetch(config, cursor);

    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual(cursor);
  });

  it("sends the stored validators back on the next poll", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(REDDIT_ATOM, {
          headers: {
            etag: 'W/"reddit-v1"',
            "last-modified": "Fri, 12 Sep 2025 09:40:00 GMT",
          },
        }),
      )
      .mockResolvedValueOnce(response("", { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await redditSource.fetch(config, null);
    await redditSource.fetch(config, first.cursor);

    expect(headersOf(fetchMock, 1)["if-none-match"]).toBe('W/"reddit-v1"');
    expect(headersOf(fetchMock, 1)["if-modified-since"]).toBe(
      "Fri, 12 Sep 2025 09:40:00 GMT",
    );
  });

  it("raises QuotaExhaustedError on 429, naming both likely causes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("too many", { status: 429 })));

    const error = await redditSource.fetch(config, null).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error.message).toMatch(/one request per minute/i);
    expect(error.message).toMatch(/user-agent/i);
  });

  it("treats 403 as transient, because Reddit throttles with it too", async () => {
    // Measured against the live endpoint: with the per-minute budget spent,
    // the SAME public subreddit alternates 200 / 403 / 429 on identical
    // headers. Classifying 403 as permanent parks a working source behind a
    // wrong explanation until a human intervenes.
    vi.stubGlobal("fetch", vi.fn(async () => response("nope", { status: 403 })));

    const error = await redditSource.fetch(config, null).catch((e) => e);

    expect(error).toBeInstanceOf(TransientError);
    // The message must offer both readings, throttling first.
    expect(error.message).toMatch(/throttling|per-minute/i);
    expect(error.message).toMatch(/private, banned or quarantined/i);
  });

  it("raises a plain error on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("nope", { status: 404 })));

    const error = await redditSource.fetch(config, null).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
    expect(error.message).toMatch(/No such subreddit/i);
  });

  it("raises TransientError on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("boom", { status: 503 })));

    await expect(redditSource.fetch(config, null)).rejects.toBeInstanceOf(
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

    await expect(redditSource.fetch(config, null)).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("does not throw on malformed or empty bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("<feed><entry>")));
    expect((await redditSource.fetch(config, null)).items).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => response("")));
    expect((await redditSource.fetch(config, null)).items).toEqual([]);
  });
});

describe("reddit validate", () => {
  it("probes with limit=1 and reports reachability", async () => {
    const fetchMock = vi.fn(async () => response(REDDIT_ATOM));
    vi.stubGlobal("fetch", fetchMock);

    const result = await redditSource.validate!({ subreddits: "r/LocalLLaMA" });

    expect(result.ok).toBe(true);
    expect(urlOf(fetchMock)).toContain("limit=1");
    expect(result.message).toContain("r/LocalLLaMA");
  });

  it("reports the 429 diagnosis rather than a bare status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("", { status: 429 })));

    const result = await redditSource.validate!({ subreddits: "LocalLLaMA" });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/user-agent/i);
  });

  it("rejects an unusable subreddit without making a request", async () => {
    const fetchMock = vi.fn(async () => response(REDDIT_ATOM));
    vi.stubGlobal("fetch", fetchMock);

    const result = await redditSource.validate!({ subreddits: "not a subreddit" });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
