import { describe, expect, it, vi } from "vitest";
import type { NormalizedItem, RenderInput } from "../core/types.js";
import { QuotaExhaustedError, TransientError } from "../core/types.js";
import {
  DEFAULT_BASE_URL,
  NOTEBOOKLM_DAILY_BUDGET,
  NOTEBOOKLM_ASK_DAILY_BUDGET,
  createNotebookLmRenderer,
  createNotebookLmTextRenderer,
  notebookLmConfigSchema,
  audioFileName,
  notebookTitle,
  type NotebookLmConfig,
  type NotebookLmDeps,
} from "./notebooklm.js";

function item(n: number): NormalizedItem {
  return {
    externalId: `e${n}`,
    url: `https://example.com/${n}`,
    title: `Item ${n}`,
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    raw: {},
  };
}

const input: RenderInput = {
  topic: { id: "t1", name: "AI safety" },
  items: [item(1), item(2)],
  jobKey: "job-123",
};

const config: NotebookLmConfig = {
  baseUrl: "http://sidecar:8000",
  pollIntervalMs: 1_000,
  maxPollMs: 10_000,
};

const AUDIO_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audioResponse(): Response {
  return new Response(AUDIO_BYTES, {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

function pendingResponse(): Response {
  return new Response(null, { status: 202 });
}

interface Harness {
  deps: NotebookLmDeps;
  calls: string[];
  writes: { path: string; bytes: number }[];
  sleeps: number[];
}

/**
 * Sidecar stub. Responses are taken in order, so a test asserts the call
 * sequence by lining the two up.
 */
function harness(responses: Response[]): Harness {
  const calls: string[] = [];
  const writes: { path: string; bytes: number }[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  let clock = 0;

  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${String(url)}`);
    return next;
  });

  return {
    calls,
    writes,
    sleeps,
    deps: {
      fetch: fetchMock as unknown as typeof fetch,
      async writeFile(path, data) {
        writes.push({ path, bytes: data.byteLength });
      },
      async sleep(ms) {
        sleeps.push(ms);
        // Virtual time: the poll deadline advances without a real wait.
        clock += ms;
      },
      now: () => clock,
      dataDir: () => "/data",
    },
  };
}

describe("notebooklm happy path", () => {
  it("creates, sources, asks, starts audio and polls in that order", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, { added: 2 }),
      jsonResponse(200, { answer: "  The digest.  " }),
      pendingResponse(),
      audioResponse(),
    ]);

    const output = await createNotebookLmRenderer(h.deps).render(config, input);

    expect(h.calls).toEqual([
      "POST http://sidecar:8000/notebooks",
      "POST http://sidecar:8000/notebooks/nb1/sources",
      "POST http://sidecar:8000/notebooks/nb1/ask",
      "POST http://sidecar:8000/notebooks/nb1/audio",
      "GET http://sidecar:8000/notebooks/nb1/audio",
    ]);
    expect(output.summary).toBe("The digest.");
  });

  it("returns a text artifact and an audio artifact", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "The digest." }),
      pendingResponse(),
      audioResponse(),
    ]);

    const output = await createNotebookLmRenderer(h.deps).render(config, input);

    expect(output.artifacts).toEqual([
      { kind: "text", mime: "text/plain", text: "The digest." },
      {
        kind: "audio",
        mime: "audio/mpeg",
        path: "ai-safety-job-123.mp3",
        bytes: AUDIO_BYTES.byteLength,
      },
    ]);
  });

  it("writes the mp3 into the data directory through the injected writer", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "The digest." }),
      pendingResponse(),
      audioResponse(),
    ]);

    await createNotebookLmRenderer(h.deps).render(config, input);

    expect(h.writes).toEqual([
      { path: "/data/ai-safety-job-123.mp3", bytes: AUDIO_BYTES.byteLength },
    ]);
  });

  it("sends the item urls as sources and the jobKey in the create body", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "The digest." }),
      pendingResponse(),
      audioResponse(),
    ]);

    await createNotebookLmRenderer(h.deps).render(config, input);

    const fetchMock = vi.mocked(h.deps.fetch);
    const createBody = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    // The machine key rides in the body, not the title.
    expect(createBody.jobKey).toBe("job-123");
    expect(createBody.title).toBe("AI safety [job-123]");

    const sourcesBody = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body),
    );
    expect(sourcesBody.urls).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
  });

  it("keeps polling while the sidecar answers 202", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "The digest." }),
      pendingResponse(),
      pendingResponse(),
      pendingResponse(),
      audioResponse(),
    ]);

    const output = await createNotebookLmRenderer(h.deps).render(config, input);

    // Two pending polls, then the ready one.
    expect(h.calls.filter((c) => c.startsWith("GET"))).toHaveLength(3);
    expect(h.sleeps).toEqual([1_000, 1_000]);
    expect(output.artifacts).toHaveLength(2);
  });
});

describe("notebooklm failure handling", () => {
  it("gives a clear error when the poll deadline passes", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "The digest." }),
      pendingResponse(),
      ...Array.from({ length: 20 }, () => pendingResponse()),
    ]);

    const error = await createNotebookLmRenderer(h.deps)
      .render({ ...config, pollIntervalMs: 4_000, maxPollMs: 8_000 }, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransientError);
    expect((error as Error).message).toMatch(/still pending after 8s/);
    expect((error as Error).message).toContain("jobKey");
    expect(h.writes).toEqual([]);
  });

  it("maps 429 to QuotaExhaustedError with the retry time", async () => {
    const h = harness([
      new Response(JSON.stringify({ detail: "daily limit" }), {
        status: 429,
        headers: { "retry-after": "3600" },
      }),
    ]);

    const error = await createNotebookLmRenderer(h.deps)
      .render(config, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).retryAfter).toBeInstanceOf(Date);
    expect((error as QuotaExhaustedError).retryAfter!.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("maps 502 to TransientError", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      new Response("upstream unavailable", { status: 502 }),
    ]);

    await expect(
      createNotebookLmRenderer(h.deps).render(config, input),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("maps 401 to a plain, non-retryable error", async () => {
    const h = harness([new Response("session expired", { status: 401 })]);

    const error = await createNotebookLmRenderer(h.deps)
      .render(config, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(QuotaExhaustedError);
    expect((error as Error).message).toMatch(/Re-authenticate/);
  });

  it("maps 404 to a plain error", async () => {
    const h = harness([new Response("no such notebook", { status: 404 })]);

    const error = await createNotebookLmRenderer(h.deps)
      .render(config, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
  });

  it("maps an unreachable sidecar to TransientError", async () => {
    const deps: NotebookLmDeps = {
      ...harness([]).deps,
      fetch: vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          code: "ECONNREFUSED",
        });
      }) as unknown as typeof fetch,
    };

    await expect(
      createNotebookLmRenderer(deps).render(config, input),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("refuses to render an empty item list", async () => {
    const h = harness([]);
    await expect(
      createNotebookLmRenderer(h.deps).render(config, { ...input, items: [] }),
    ).rejects.toThrow(/item list is empty/);
    expect(h.calls).toEqual([]);
  });
});

describe("notebooklm manifest and config", () => {
  it("declares audio output and the Pro daily budget", () => {
    const renderer = createNotebookLmRenderer(harness([]).deps);
    expect(renderer.id).toBe("notebooklm");
    expect(renderer.produces).toEqual({ text: true, audio: true });
    expect(renderer.dailyBudget).toBe(NOTEBOOKLM_DAILY_BUDGET);
    expect(NOTEBOOKLM_DAILY_BUDGET).toBe(20);
  });

  it("falls back to the default sidecar url", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "The digest." }),
      pendingResponse(),
      audioResponse(),
    ]);

    await createNotebookLmRenderer(h.deps).render({}, input);

    expect(h.calls[0]).toBe(`POST ${DEFAULT_BASE_URL}/notebooks`);
  });

  it("accepts an empty config and rejects invalid input", () => {
    expect(notebookLmConfigSchema.safeParse({}).success).toBe(true);
    expect(
      notebookLmConfigSchema.safeParse({ baseUrl: "not a url" }).success,
    ).toBe(false);
    expect(
      notebookLmConfigSchema.safeParse({ timeoutMs: 0 }).success,
    ).toBe(false);
    expect(
      notebookLmConfigSchema.safeParse({ pollIntervalMs: -1 }).success,
    ).toBe(false);
    expect(
      notebookLmConfigSchema.safeParse({ maxPollMs: 1.5 }).success,
    ).toBe(false);
  });
});

describe("notebookTitle", () => {
  /** The real shape produced by makeJobKey: "<uuid>:<YYYYMMDDHHMM>". */
  const realJobKey = "f8f9161c-5c5b-4a67-abbf-5a464f1bc5fa:202609130049";

  function withKey(jobKey: string, name = "AI News"): RenderInput {
    return { topic: { id: "t1", name }, items: [], jobKey };
  }

  it("reads as topic name plus a human date, with no uuid", () => {
    const title = notebookTitle(withKey(realJobKey));
    expect(title).toBe("AI News - 2026-09-13 00:49");
    expect(title).not.toContain("f8f9161c");
  });

  it("stays distinct for two digests of the same topic", () => {
    // Different minutes must not collide in the NotebookLM list.
    const a = notebookTitle(withKey("t:202609130049"));
    const b = notebookTitle(withKey("t:202609130050"));
    expect(a).not.toBe(b);
  });

  it("distinguishes topics rendered in the same minute", () => {
    expect(notebookTitle(withKey("a:202609130049", "AI News"))).not.toBe(
      notebookTitle(withKey("a:202609130049", "Rust News")),
    );
  });

  it("falls back to the raw jobKey when the shape is unrecognised", () => {
    // Never produce a non-unique title: an orphaned notebook must stay findable.
    expect(notebookTitle(withKey("job-123"))).toBe("AI News [job-123]");
  });

  it("does not mistake a long digit run for a stamp", () => {
    expect(notebookTitle(withKey("t:1234567890123"))).toBe(
      "AI News [t:1234567890123]",
    );
  });
});

describe("notebook lifecycle", () => {
  // One digest should mean one notebook. Before cleanup existed, every failed
  // attempt abandoned the notebook it had created: four debugging runs left
  // four identically-titled orphans against an account capped at 500.
  it("deletes the notebook when adding sources fails", async () => {
    const h = harness([
      jsonResponse(201, { notebook_id: "nb-orphan" }),
      jsonResponse(502, { error: "upstream_unavailable", detail: "no sources" }),
      jsonResponse(200, {}), // the DELETE
    ]);

    await createNotebookLmTextRenderer(h.deps)
      .render(config, input)
      .catch(() => undefined);

    expect(h.calls).toContain(
      "DELETE http://sidecar:8000/notebooks/nb-orphan",
    );
  });

  it("deletes the notebook when the summary comes back empty", async () => {
    const h = harness([
      jsonResponse(201, { notebook_id: "nb-empty" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "   " }),
      jsonResponse(200, {}), // the DELETE
    ]);

    await createNotebookLmTextRenderer(h.deps)
      .render(config, input)
      .catch(() => undefined);

    expect(h.calls).toContain("DELETE http://sidecar:8000/notebooks/nb-empty");
  });

  it("KEEPS the notebook on success", async () => {
    const h = harness([
      jsonResponse(201, { notebook_id: "nb-keep" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "Digest." }),
    ]);

    await createNotebookLmTextRenderer(h.deps).render(config, input);

    expect(h.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("reports the ORIGINAL error even when cleanup also fails", async () => {
    // Replacing the real cause with "cleanup failed" would send you looking in
    // entirely the wrong place.
    const h = harness([
      jsonResponse(201, { notebook_id: "nb-x" }),
      jsonResponse(502, { error: "upstream_unavailable", detail: "real cause" }),
      jsonResponse(500, { error: "delete blew up" }),
    ]);

    const error = await createNotebookLmTextRenderer(h.deps)
      .render(config, input)
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain("add sources");
    expect((error as Error).message).not.toContain("discard");
  });
});

describe("sidecar response contract", () => {
  // These two halves were built to briefs that disagreed: the sidecar returns
  // notebook_id, the renderer originally read id. Both unit suites passed
  // because each mocked its own assumption. The mismatch only surfaced on the
  // first real HTTP call between them, as "created a notebook without
  // returning an id". These tests pin the field name so it cannot drift again.
  it("accepts notebook_id, which is what the sidecar actually sends", async () => {
    const h = harness([
      jsonResponse(201, { notebook_id: "nb-real" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "Digest." }),
    ]);

    const output = await createNotebookLmTextRenderer(h.deps).render(
      config,
      input,
    );

    expect(output.summary).toBe("Digest.");
    expect(h.calls[1]).toContain("/notebooks/nb-real/sources");
  });

  it("accepts id too, so a different adapter can be dropped in", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb-alt" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "Digest." }),
    ]);

    await createNotebookLmTextRenderer(h.deps).render(config, input);
    expect(h.calls[1]).toContain("/notebooks/nb-alt/sources");
  });

  it("names both fields when neither is present", async () => {
    const h = harness([jsonResponse(201, { unexpected: "shape" })]);

    const error = await createNotebookLmTextRenderer(h.deps)
      .render(config, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransientError);
    expect((error as Error).message).toContain("notebook_id");
    expect((error as Error).message).toContain("unexpected");
  });
});

describe("notebooklm-text (summary only)", () => {
  it("stops after asking: it never calls the audio endpoints", async () => {
    // This is the entire reason the plugin exists. An audio overview is one of
    // 20 per day; asking is one of ~500. Touching /audio here would spend 5% of
    // the daily podcast budget to produce a paragraph of text.
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, { added: 2 }),
      jsonResponse(200, { answer: "  The written digest.  " }),
    ]);

    const output = await createNotebookLmTextRenderer(h.deps).render(
      config,
      input,
    );

    expect(h.calls).toEqual([
      "POST http://sidecar:8000/notebooks",
      "POST http://sidecar:8000/notebooks/nb1/sources",
      "POST http://sidecar:8000/notebooks/nb1/ask",
    ]);
    expect(h.calls.some((c) => c.includes("/audio"))).toBe(false);
    expect(output.summary).toBe("The written digest.");
  });

  it("returns only a text artifact and writes no file", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "Digest." }),
    ]);

    const output = await createNotebookLmTextRenderer(h.deps).render(
      config,
      input,
    );

    expect(output.artifacts).toEqual([
      { kind: "text", mime: "text/plain", text: "Digest." },
    ]);
    expect(h.writes).toEqual([]);
  });

  it("declares a far larger budget than the audio renderer", () => {
    const text = createNotebookLmTextRenderer(harness([]).deps);
    const audio = createNotebookLmRenderer(harness([]).deps);

    expect(text.produces).toEqual({ text: true, audio: false });
    expect(text.dailyBudget).toBe(NOTEBOOKLM_ASK_DAILY_BUDGET);
    expect(text.dailyBudget!).toBeGreaterThan(audio.dailyBudget!);
  });

  it("sends the same sources and title as the audio renderer", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "Digest." }),
    ]);

    await createNotebookLmTextRenderer(h.deps).render(config, input);

    const fetchMock = vi.mocked(h.deps.fetch);
    const createBody = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(createBody.title).toBe(notebookTitle(input));
    expect(createBody.jobKey).toBe("job-123");

    const sourcesBody = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body),
    );
    expect(sourcesBody.urls).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
  });

  it("refuses an empty item list", async () => {
    const h = harness([]);
    await expect(
      createNotebookLmTextRenderer(h.deps).render(config, {
        ...input,
        items: [],
      }),
    ).rejects.toThrow(/item list is empty/);
    expect(h.calls).toEqual([]);
  });

  it("maps 429 to QuotaExhaustedError like the audio renderer", async () => {
    const h = harness([
      new Response(JSON.stringify({ detail: "chat limit" }), { status: 429 }),
    ]);

    await expect(
      createNotebookLmTextRenderer(h.deps).render(config, input),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("treats an empty answer as transient rather than shipping a blank digest", async () => {
    const h = harness([
      jsonResponse(201, { id: "nb1" }),
      jsonResponse(200, {}),
      jsonResponse(200, { answer: "   " }),
    ]);

    await expect(
      createNotebookLmTextRenderer(h.deps).render(config, input),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("audioFileName", () => {
  const realJobKey = "f8f9161c-5c5b-4a67-abbf-5a464f1bc5fa:202609130049";

  function withTopic(
    topic: RenderInput["topic"],
    jobKey = realJobKey,
  ): RenderInput {
    return { topic, items: [], jobKey };
  }

  it("names the file from the topic slug and a readable date", () => {
    expect(
      audioFileName(withTopic({ id: "t", name: "AI News", slug: "ai-news" })),
    ).toBe("ai-news-2026-09-13-0049.mp3");
  });

  it("never emits a colon, which is illegal on Windows", () => {
    // Telegram shows the basename in chat and the file gets saved by real
    // people on real machines, so this is a portability bug, not a nitpick.
    const name = audioFileName(
      withTopic({ id: "t", name: "AI News", slug: "ai-news" }),
    );
    expect(name).not.toContain(":");
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it("carries no uuid into the filename", () => {
    const name = audioFileName(
      withTopic({ id: "t", name: "AI News", slug: "ai-news" }),
    );
    expect(name).not.toContain("f8f9161c");
  });

  it("falls back to the topic name when no slug is supplied", () => {
    expect(audioFileName(withTopic({ id: "t", name: "AI News" }))).toBe(
      "ai-news-2026-09-13-0049.mp3",
    );
  });

  it("sanitises a hostile slug rather than trusting it as a path", () => {
    // The slug is user-entered, so it cannot be pasted into a path unchecked.
    const name = audioFileName(
      withTopic({ id: "t", name: "x", slug: "../../etc/passwd" }),
    );
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name).toBe("etc-passwd-2026-09-13-0049.mp3");
  });

  it("handles a slug of only punctuation without producing an empty name", () => {
    expect(audioFileName(withTopic({ id: "t", name: "!!!", slug: "???" }))).toBe(
      "topic-2026-09-13-0049.mp3",
    );
  });

  it("stays unique across minutes for one topic", () => {
    const a = audioFileName(withTopic({ id: "t", name: "N", slug: "n" }, "x:202609130049"));
    const b = audioFileName(withTopic({ id: "t", name: "N", slug: "n" }, "x:202609130050"));
    expect(a).not.toBe(b);
  });

  it("keeps a unique name when the jobKey shape is unrecognised", () => {
    expect(
      audioFileName(withTopic({ id: "t", name: "N", slug: "n" }, "job-123")),
    ).toBe("n-job-123.mp3");
  });
});
