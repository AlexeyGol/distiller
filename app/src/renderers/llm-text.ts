import { z } from "zod";
import type {
  Artifact,
  RenderInput,
  RenderOutput,
  RendererPlugin,
  ValidationResult,
} from "../core/types.js";
import { QuotaExhaustedError, TransientError } from "../core/types.js";

/**
 * Plain text digest renderer.
 *
 * This is the fallback path: when the NotebookLM sidecar breaks - and browser
 * automation against an undocumented product will break - the digest still has
 * to go out. So this renderer stays boring on purpose: one prompt, one model
 * call, one text artifact, no local audio pipeline, no exotic dependencies.
 *
 * Provider construction is injected (see LlmTextDeps) for two reasons: tests
 * must never touch the network, and the provider packages are imported only
 * when they are actually used, so a provider that is not installed cannot break
 * this module at import time.
 */

export const llmTextConfigSchema = z.object({
  provider: z.enum(["gemini", "anthropic", "ollama"]),
  /** Provider-specific model id, e.g. "gemini-2.0-flash" or "llama3.1". */
  model: z.string().min(1),
  /** Not needed for ollama; hosted providers also accept their own env var. */
  apiKey: z.string().min(1).optional(),
  /** Overrides the provider endpoint. Used in practice for ollama. */
  baseUrl: z.string().url().optional(),
  /** Replaces DEFAULT_LLM_PROMPT. The item list is always appended after it. */
  prompt: z.string().min(1).optional(),
});

export type LlmTextConfig = z.infer<typeof llmTextConfigSchema>;

/** Default ollama endpoint when the config leaves baseUrl unset. */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * The instruction half of the prompt. Exported so it is testable, and so the
 * UI can show the operator exactly what config.prompt overrides.
 */
export const DEFAULT_LLM_PROMPT = [
  "You are writing a daily digest that will be read aloud.",
  "Summarise the items below into a single flowing brief.",
  "",
  "Rules:",
  "- Lead with the two or three most consequential items.",
  "- Group related items together instead of walking the list in order.",
  "- One short paragraph per theme, plain prose, no markdown, no bullet points.",
  "- Say what happened and why it matters; skip hype and skip boilerplate.",
  "- If an item has no real substance, leave it out rather than padding.",
  "- Do not invent anything that is not in the source text.",
].join("\n");

/** Keeps one oversized article from crowding the whole prompt out. */
const MAX_BODY_CHARS = 4_000;

export function buildPrompt(config: LlmTextConfig, input: RenderInput): string {
  const parts: string[] = [config.prompt ?? DEFAULT_LLM_PROMPT, ""];

  parts.push(`Topic: ${input.topic.name}`);
  if (input.topic.description) {
    parts.push(`Topic description: ${input.topic.description}`);
  }
  parts.push("", `Items (${input.items.length}):`, "");

  input.items.forEach((item, index) => {
    parts.push(`${index + 1}. ${item.title}`);
    parts.push(`   URL: ${item.url}`);
    const body = item.body?.trim();
    if (body) {
      parts.push(`   ${truncate(body, MAX_BODY_CHARS).replace(/\n/g, "\n   ")}`);
    }
    parts.push("");
  });

  return parts.join("\n").trimEnd();
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** Structural stand-in for an AI SDK language model; we never inspect it. */
export type LanguageModelHandle = unknown;

export interface LlmTextDeps {
  /** Builds the AI SDK model handle for a hosted provider. */
  createModel(config: LlmTextConfig): Promise<LanguageModelHandle>;
  /** `generateText` from the `ai` package, narrowed to what we use. */
  generateText(args: {
    model: LanguageModelHandle;
    prompt: string;
  }): Promise<{ text: string }>;
  /** Used only by the ollama path, which talks plain HTTP. */
  fetch: typeof fetch;
}

async function createRealModel(
  config: LlmTextConfig,
): Promise<LanguageModelHandle> {
  if (config.provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })(config.model);
  }
  if (config.provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })(config.model);
  }
  throw new Error(`createModel does not handle provider "${config.provider}"`);
}

async function realGenerateText(args: {
  model: LanguageModelHandle;
  prompt: string;
}): Promise<{ text: string }> {
  const { generateText } = await import("ai");
  const result = await generateText({
    model: args.model as Parameters<typeof generateText>[0]["model"],
    prompt: args.prompt,
  });
  return { text: result.text };
}

export const defaultLlmTextDeps: LlmTextDeps = {
  createModel: createRealModel,
  generateText: realGenerateText,
  fetch: (...args) => fetch(...args),
};

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

async function complete(
  deps: LlmTextDeps,
  config: LlmTextConfig,
  prompt: string,
): Promise<string> {
  try {
    if (config.provider === "ollama") {
      return await completeWithOllama(deps, config, prompt);
    }
    const model = await deps.createModel(config);
    const { text } = await deps.generateText({ model, prompt });
    return text;
  } catch (error) {
    throw classifyProviderError(error);
  }
}

/**
 * ollama speaks an OpenAI-compatible API, so there is no provider package to
 * pull in - one POST is the whole integration.
 */
async function completeWithOllama(
  deps: LlmTextDeps,
  config: LlmTextConfig,
  prompt: string,
): Promise<string> {
  const base = (config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const response = await deps.fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      `ollama returned ${response.status}`,
      response.headers?.get?.("retry-after") ?? undefined,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("ollama returned an empty completion");
  }
  return text;
}

/** Carries an HTTP status through to classifyProviderError. */
class HttpStatusError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Maps whatever a provider threw onto the two errors the worker understands.
 * Duck-typed rather than instanceof-checked: AI SDK errors, our own
 * HttpStatusError and a raw fetch TypeError all have to land in the same place,
 * and pinning this to APICallError would couple the fallback renderer to one
 * SDK version.
 */
export function classifyProviderError(error: unknown): unknown {
  if (error instanceof QuotaExhaustedError || error instanceof TransientError) {
    return error;
  }

  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new QuotaExhaustedError(
      `LLM provider rate limit: ${message}`,
      retryAfterOf(error),
    );
  }
  if (status !== undefined && status >= 500) {
    return new TransientError(`LLM provider ${status}: ${message}`, {
      cause: error,
    });
  }
  if (isNetworkError(error)) {
    return new TransientError(`LLM provider unreachable: ${message}`, {
      cause: error,
    });
  }
  return error;
}

function statusOf(error: unknown): number | undefined {
  for (const node of causeChain(error)) {
    const record = node as { statusCode?: unknown; status?: unknown };
    const raw = record.statusCode ?? record.status;
    if (typeof raw === "number") return raw;
  }
  return undefined;
}

function retryAfterOf(error: unknown): Date | undefined {
  for (const node of causeChain(error)) {
    const record = node as {
      retryAfter?: unknown;
      responseHeaders?: Record<string, string>;
    };
    const raw =
      typeof record.retryAfter === "string"
        ? record.retryAfter
        : record.responseHeaders?.["retry-after"];
    if (typeof raw !== "string") continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  for (const node of causeChain(error)) {
    const record = node as { code?: unknown; name?: unknown; message?: unknown };
    if (
      typeof record.code === "string" &&
      NETWORK_ERROR_CODES.has(record.code)
    ) {
      return true;
    }
    if (
      record.name === "TypeError" &&
      typeof record.message === "string" &&
      /fetch failed|network|socket/i.test(record.message)
    ) {
      return true;
    }
  }
  return false;
}

/** Walks `cause` links so a wrapped SDK error still reveals its status. */
function* causeChain(error: unknown): Generator<object> {
  let node: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof node !== "object" || node === null) return;
    yield node;
    node = (node as { cause?: unknown }).cause;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function createLlmTextRenderer(
  deps: LlmTextDeps = defaultLlmTextDeps,
): RendererPlugin<LlmTextConfig> {
  return {
    kind: "renderer",
    id: "llm-text",
    label: "LLM text summary",
    description:
      "Summarises a topic's items into a text digest with Gemini, Claude or a local ollama model. The fallback when audio rendering is unavailable.",
    configSchema: llmTextConfigSchema,
    produces: { text: true, audio: false },

    async validate(config: LlmTextConfig): Promise<ValidationResult> {
      try {
        const text = await complete(
          deps,
          config,
          "Reply with the single word OK.",
        );
        return {
          ok: true,
          message: `${config.provider}/${config.model} replied: ${truncate(
            text.trim(),
            80,
          )}`,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async render(
      config: LlmTextConfig,
      input: RenderInput,
    ): Promise<RenderOutput> {
      if (input.items.length === 0) {
        throw new Error("llm-text: nothing to render, the item list is empty");
      }

      const raw = await complete(deps, config, buildPrompt(config, input));
      const summary = raw.trim();
      if (summary === "") {
        throw new TransientError(
          "llm-text: the model returned an empty summary",
        );
      }

      const artifact: Artifact = {
        kind: "text",
        mime: "text/plain",
        text: summary,
      };
      return { summary, artifacts: [artifact] };
    },
  };
}

/** Registry instance. Tests build their own with createLlmTextRenderer. */
export const llmTextRenderer = createLlmTextRenderer();
