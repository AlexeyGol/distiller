import { describe, expect, it, vi } from "vitest";
import type { NormalizedItem, RenderInput } from "../core/types.js";
import { QuotaExhaustedError, TransientError } from "../core/types.js";
import {
  DEFAULT_LLM_PROMPT,
  buildPrompt,
  createLlmTextRenderer,
  llmTextConfigSchema,
  type LlmTextConfig,
  type LlmTextDeps,
} from "./llm-text.js";

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: "e1",
    url: "https://example.com/a",
    title: "Anthropic ships a thing",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    body: "Body text for the first item.",
    raw: {},
    ...overrides,
  };
}

const input: RenderInput = {
  topic: { id: "t1", name: "AI safety", description: "Alignment news" },
  items: [
    item(),
    item({
      externalId: "e2",
      url: "https://example.com/b",
      title: "Regulator publishes draft rules",
      body: undefined,
    }),
  ],
  jobKey: "job-123",
};

const geminiConfig: LlmTextConfig = {
  provider: "gemini",
  model: "gemini-2.0-flash",
  apiKey: "k",
};

/** Deps that answer with a fixed completion and never touch the network. */
function stubDeps(overrides: Partial<LlmTextDeps> = {}): LlmTextDeps {
  return {
    createModel: vi.fn(async () => ({ id: "stub-model" })),
    generateText: vi.fn(async () => ({ text: "  A tidy digest.  " })),
    fetch: vi.fn(async () => {
      throw new Error("fetch must not be called for hosted providers");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("llm-text prompt", () => {
  it("includes the topic, the description and every item title and url", () => {
    const prompt = buildPrompt(geminiConfig, input);

    expect(prompt).toContain(DEFAULT_LLM_PROMPT);
    expect(prompt).toContain("Topic: AI safety");
    expect(prompt).toContain("Topic description: Alignment news");
    expect(prompt).toContain("1. Anthropic ships a thing");
    expect(prompt).toContain("https://example.com/a");
    expect(prompt).toContain("2. Regulator publishes draft rules");
    expect(prompt).toContain("https://example.com/b");
    expect(prompt).toContain("Body text for the first item.");
  });

  it("honours a custom prompt from config instead of the default", () => {
    const prompt = buildPrompt(
      { ...geminiConfig, prompt: "Write it as limericks." },
      input,
    );

    expect(prompt).toContain("Write it as limericks.");
    expect(prompt).not.toContain(DEFAULT_LLM_PROMPT);
    // The item list is still appended after the override.
    expect(prompt).toContain("1. Anthropic ships a thing");
  });
});

describe("llm-text render", () => {
  it("returns a single trimmed text artifact", async () => {
    const deps = stubDeps();
    const renderer = createLlmTextRenderer(deps);

    const output = await renderer.render(geminiConfig, input);

    expect(output.summary).toBe("A tidy digest.");
    expect(output.artifacts).toEqual([
      { kind: "text", mime: "text/plain", text: "A tidy digest." },
    ]);
    expect(renderer.produces).toEqual({ text: true, audio: false });
    expect(renderer.id).toBe("llm-text");
  });

  it("passes the built prompt to the model", async () => {
    const deps = stubDeps();
    await createLlmTextRenderer(deps).render(geminiConfig, input);

    const call = vi.mocked(deps.generateText).mock.calls[0][0];
    expect(call.prompt).toContain("Topic: AI safety");
    expect(call.prompt).toContain("Regulator publishes draft rules");
    expect(deps.createModel).toHaveBeenCalledWith(geminiConfig);
  });

  it("rejects an empty item list before calling the provider", async () => {
    const deps = stubDeps();
    await expect(
      createLlmTextRenderer(deps).render(geminiConfig, { ...input, items: [] }),
    ).rejects.toThrow(/item list is empty/);
    expect(deps.generateText).not.toHaveBeenCalled();
  });

  it("uses the ollama HTTP endpoint rather than a provider package", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "Local digest." } }],
      }),
    );
    const deps = stubDeps({ fetch: fetchMock as unknown as typeof fetch });

    const output = await createLlmTextRenderer(deps).render(
      { provider: "ollama", model: "llama3.1", baseUrl: "http://ollama:11434" },
      input,
    );

    expect(output.summary).toBe("Local digest.");
    expect(deps.createModel).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://ollama:11434/v1/chat/completions");
    expect(JSON.parse(String(init.body)).model).toBe("llama3.1");
  });
});

describe("llm-text error mapping", () => {
  it("maps a provider rate limit to QuotaExhaustedError with the retry time", async () => {
    const rateLimited = Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "60" },
    });
    const deps = stubDeps({
      generateText: vi.fn(async () => {
        throw rateLimited;
      }),
    });

    const error = await createLlmTextRenderer(deps)
      .render(geminiConfig, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    const retryAfter = (error as QuotaExhaustedError).retryAfter;
    expect(retryAfter).toBeInstanceOf(Date);
    expect(retryAfter!.getTime()).toBeGreaterThan(Date.now());
  });

  it("maps a provider 5xx to TransientError", async () => {
    const deps = stubDeps({
      generateText: vi.fn(async () => {
        throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
      }),
    });

    await expect(
      createLlmTextRenderer(deps).render(geminiConfig, input),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("maps an ollama 503 to TransientError", async () => {
    const deps = stubDeps({
      fetch: vi.fn(async () =>
        jsonResponse(503, { error: "model loading" }),
      ) as unknown as typeof fetch,
    });

    await expect(
      createLlmTextRenderer(deps).render(
        { provider: "ollama", model: "llama3.1" },
        input,
      ),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("maps an ollama 429 to QuotaExhaustedError", async () => {
    const deps = stubDeps({
      fetch: vi.fn(async () =>
        jsonResponse(429, { error: "busy" }),
      ) as unknown as typeof fetch,
    });

    await expect(
      createLlmTextRenderer(deps).render(
        { provider: "ollama", model: "llama3.1" },
        input,
      ),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("maps a network failure to TransientError", async () => {
    const deps = stubDeps({
      generateText: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });

    await expect(
      createLlmTextRenderer(deps).render(geminiConfig, input),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("leaves a non-retryable provider error alone", async () => {
    const deps = stubDeps({
      generateText: vi.fn(async () => {
        throw Object.assign(new Error("Invalid API key"), { statusCode: 401 });
      }),
    });

    const error = await createLlmTextRenderer(deps)
      .render(geminiConfig, input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(QuotaExhaustedError);
  });
});

describe("llm-text config schema", () => {
  it("accepts a valid config", () => {
    expect(llmTextConfigSchema.parse(geminiConfig)).toEqual(geminiConfig);
  });

  it("rejects an unknown provider", () => {
    expect(
      llmTextConfigSchema.safeParse({ provider: "openai", model: "gpt" })
        .success,
    ).toBe(false);
  });

  it("rejects an empty model and a non-url baseUrl", () => {
    expect(
      llmTextConfigSchema.safeParse({ provider: "gemini", model: "" }).success,
    ).toBe(false);
    expect(
      llmTextConfigSchema.safeParse({
        provider: "ollama",
        model: "llama3.1",
        baseUrl: "not-a-url",
      }).success,
    ).toBe(false);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
