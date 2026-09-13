import { describe, expect, it, vi } from "vitest";
import type { Artifact, DigestView } from "../core/types.js";
import { QuotaExhaustedError, TransientError } from "../core/types.js";
import {
  TELEGRAM_MAX_UPLOAD_BYTES,
  createTelegramSink,
  telegramConfigSchema,
  type TelegramConfig,
  type TelegramDeps,
} from "./telegram.js";

const config: TelegramConfig = { botToken: "123:abc", chatId: "-100999" };

const digest: DigestView = {
  id: "d1",
  topicName: "AI safety",
  summary: "Three things happened today.",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  itemCount: 3,
};

const audioArtifact: Artifact = {
  kind: "audio",
  mime: "audio/mpeg",
  path: "job-123.mp3",
  bytes: 1_024,
};

const textArtifact: Artifact = {
  kind: "text",
  mime: "text/plain",
  text: "Three things happened today.",
};

interface Harness {
  deps: TelegramDeps;
  calls: { method: string; body: BodyInit | null | undefined }[];
  reads: string[];
}

function harness(
  responses: Response[],
  fileBytes = new Uint8Array(1_024),
): Harness {
  const calls: { method: string; body: BodyInit | null | undefined }[] = [];
  const reads: string[] = [];
  const queue = [...responses];

  return {
    calls,
    reads,
    deps: {
      fetch: vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({
          method: String(url).split("/").pop() ?? "",
          body: init?.body,
        });
        const next = queue.shift();
        if (!next) throw new Error(`unexpected request: ${String(url)}`);
        return next;
      }) as unknown as typeof fetch,
      async readFile(path) {
        reads.push(path);
        return fileBytes;
      },
      dataDir: () => "/data",
    },
  };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("telegram delivery", () => {
  it("sends the summary first, then the audio, and returns the message id", async () => {
    const h = harness([ok({ message_id: 42 }), ok({ message_id: 43 })]);

    const result = await createTelegramSink(h.deps).deliver(
      config,
      digest,
      [textArtifact, audioArtifact],
    );

    expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "sendAudio"]);
    expect(result.externalRef).toBe("42");

    const sent = JSON.parse(String(h.calls[0].body));
    expect(sent.chat_id).toBe("-100999");
    expect(sent.text).toContain("AI safety");
    expect(sent.text).toContain("Three things happened today.");
    expect(h.reads).toEqual(["/data/job-123.mp3"]);
  });

  it("sends only the message when there is no audio artifact", async () => {
    const h = harness([ok({ message_id: 7 })]);

    const result = await createTelegramSink(h.deps).deliver(config, digest, [
      textArtifact,
    ]);

    expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(result.externalRef).toBe("7");
  });

  it("uses sendDocument when configured", async () => {
    const h = harness([ok({ message_id: 1 }), ok({ message_id: 2 })]);

    await createTelegramSink(h.deps).deliver(
      { ...config, sendAudioAsDocument: true },
      digest,
      [audioArtifact],
    );

    expect(h.calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "sendDocument",
    ]);
    const form = h.calls[1].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("document")).toBeInstanceOf(Blob);
    expect(form.get("audio")).toBeNull();
    expect((form.get("document") as File).name).toBe("job-123.mp3");
  });

  it("truncates a summary past the Telegram message limit", async () => {
    const h = harness([ok({ message_id: 1 })]);

    await createTelegramSink(h.deps).deliver(
      config,
      { ...digest, summary: "x".repeat(5_000) },
      [],
    );

    const sent = JSON.parse(String(h.calls[0].body));
    expect(sent.text).toHaveLength(4_096);
    expect(sent.text.endsWith("...")).toBe(true);
  });
});

describe("telegram size limits", () => {
  it("rejects audio over the 50 MB upload limit before reading or uploading", async () => {
    const h = harness([ok({ message_id: 1 })]);

    const error = await createTelegramSink(h.deps)
      .deliver(config, digest, [
        { ...audioArtifact, bytes: TELEGRAM_MAX_UPLOAD_BYTES + 1 },
      ])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/over the 50.0 MB bot upload limit/);
    expect(h.reads).toEqual([]);
    // Only the summary went out; no upload was attempted.
    expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });

  it("also catches an oversized file whose recorded size was missing", async () => {
    const h = harness(
      [ok({ message_id: 1 })],
      new Uint8Array(TELEGRAM_MAX_UPLOAD_BYTES + 1),
    );

    await expect(
      createTelegramSink(h.deps).deliver(config, digest, [
        { kind: "audio", mime: "audio/mpeg", path: "big.mp3" },
      ]),
    ).rejects.toThrow(/bot upload limit/);
    expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });
});

describe("telegram error mapping", () => {
  it("maps 429 to QuotaExhaustedError carrying retry_after", async () => {
    const h = harness([
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30",
          parameters: { retry_after: 30 },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    ]);

    const before = Date.now();
    const error = await createTelegramSink(h.deps)
      .deliver(config, digest, [])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    const retryAfter = (error as QuotaExhaustedError).retryAfter;
    expect(retryAfter).toBeInstanceOf(Date);
    expect(retryAfter!.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(retryAfter!.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("maps a 5xx to TransientError", async () => {
    const h = harness([new Response("bad gateway", { status: 502 })]);

    await expect(
      createTelegramSink(h.deps).deliver(config, digest, []),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("maps a network failure to TransientError", async () => {
    const h = harness([]);
    const deps: TelegramDeps = {
      ...h.deps,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    };

    await expect(
      createTelegramSink(deps).deliver(config, digest, []),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("maps a 400 to a plain, non-retryable error", async () => {
    const h = harness([
      new Response(
        JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ]);

    const error = await createTelegramSink(h.deps)
      .deliver(config, digest, [])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
    expect((error as Error).message).toMatch(/chat not found/);
  });
});

describe("telegram manifest and config", () => {
  it("accepts text and audio artifacts", () => {
    const sink = createTelegramSink(harness([]).deps);
    expect(sink.id).toBe("telegram");
    expect(sink.kind).toBe("sink");
    expect(sink.accepts).toEqual(["text", "audio"]);
  });

  it("rejects invalid config", () => {
    expect(telegramConfigSchema.safeParse(config).success).toBe(true);
    expect(
      telegramConfigSchema.safeParse({ botToken: "", chatId: "1" }).success,
    ).toBe(false);
    expect(telegramConfigSchema.safeParse({ botToken: "t" }).success).toBe(
      false,
    );
    expect(
      telegramConfigSchema.safeParse({
        botToken: "t",
        chatId: "1",
        sendAudioAsDocument: "yes",
      }).success,
    ).toBe(false);
  });
});
