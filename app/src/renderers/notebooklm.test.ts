import { describe, expect, it, vi } from "vitest";
import type { NormalizedItem, RenderInput } from "../core/types.js";
import { QuotaExhaustedError, TransientError } from "../core/types.js";
import {
  DEFAULT_BASE_URL,
  NOTEBOOKLM_DAILY_BUDGET,
  createNotebookLmRenderer,
  notebookLmConfigSchema,
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
        path: "job-123.mp3",
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
      { path: "/data/job-123.mp3", bytes: AUDIO_BYTES.byteLength },
    ]);
  });

  it("sends the item urls as sources and the jobKey in the notebook title", async () => {
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
    expect(createBody.title).toBe("AI safety [job-123]");
    expect(createBody.title).toContain(input.jobKey);
    expect(createBody.jobKey).toBe("job-123");
    expect(notebookTitle(input)).toBe("AI safety [job-123]");

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
