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
 * NotebookLM renderer - an HTTP client for the Python sidecar, nothing else.
 *
 * All of the fragile parts (a logged-in browser session, the undocumented
 * NotebookLM UI, cookie refresh) live in the sidecar process. This file
 * deliberately knows none of that: it speaks one small JSON contract over HTTP,
 * so when the sidecar is rewritten or replaced nothing here has to change, and
 * when it breaks the worker falls back to the llm-text renderer.
 *
 * Sidecar contract:
 *   POST   /notebooks                  {title, jobKey}   -> 201 {id}
 *   POST   /notebooks/{id}/sources     {urls}            -> 200
 *   POST   /notebooks/{id}/ask         {question}        -> 200 {answer}
 *   POST   /notebooks/{id}/audio       {instructions}    -> 202 (generation started)
 *   GET    /notebooks/{id}/audio                         -> 202 while pending,
 *                                                           200 audio/mpeg body when ready
 *
 * Status mapping, agreed with the sidecar author:
 *   429 -> QuotaExhaustedError (the Pro account's 20 audio overviews are gone)
 *   401 -> plain Error (the session needs a human; retrying cannot fix it)
 *   404 -> plain Error (the notebook vanished; a retry would fail the same way)
 *   502 -> TransientError (the sidecar could not reach NotebookLM right now)
 *   202 -> still pending, keep polling
 */

export const notebookLmConfigSchema = z.object({
  /** Sidecar root. Defaults to DEFAULT_BASE_URL when omitted. */
  baseUrl: z.string().url().optional(),
  /** Per-request timeout. Does not bound the audio poll; maxPollMs does. */
  timeoutMs: z.number().int().positive().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  maxPollMs: z.number().int().positive().optional(),
  /** Extra steering passed to NotebookLM's audio overview generator. */
  instructions: z.string().min(1).optional(),
});

export type NotebookLmConfig = z.infer<typeof notebookLmConfigSchema>;

export const DEFAULT_BASE_URL = "http://sidecar:8000";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Audio overviews routinely take several minutes to generate. */
export const DEFAULT_MAX_POLL_MS = 15 * 60_000;

/** NotebookLM Pro allows 20 audio overviews per day. */
export const NOTEBOOKLM_DAILY_BUDGET = 20;

export const DEFAULT_QUESTION =
  "Summarise these sources as a single spoken-word digest: lead with what matters most, group related items, and skip anything without substance.";

interface ResolvedConfig {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxPollMs: number;
  instructions?: string;
}

function resolveConfig(config: NotebookLmConfig): ResolvedConfig {
  return {
    baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxPollMs: config.maxPollMs ?? DEFAULT_MAX_POLL_MS,
    instructions: config.instructions,
  };
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface NotebookLmDeps {
  fetch: typeof fetch;
  /** Writes the mp3. Takes an absolute path; creates parent directories. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Injected so the polling test does not spend real seconds waiting. */
  sleep(ms: number): Promise<void>;
  /** Elapsed-time source for the poll deadline. */
  now(): number;
  /** Data volume root. Artifact paths are relative to this. */
  dataDir(): string;
}

async function realWriteFile(path: string, data: Uint8Array): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export const defaultNotebookLmDeps: NotebookLmDeps = {
  fetch: (...args) => fetch(...args),
  writeFile: realWriteFile,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
  dataDir: () => process.env.DATA_DIR ?? "/data",
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface SidecarResponse {
  status: number;
  response: Response;
}

async function call(
  deps: NotebookLmDeps,
  resolved: ResolvedConfig,
  path: string,
  init: RequestInit,
  context: string,
): Promise<SidecarResponse> {
  let response: Response;
  try {
    response = await deps.fetch(`${resolved.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(resolved.timeoutMs),
    });
  } catch (error) {
    // A dead or restarting sidecar is exactly the case worth retrying.
    throw new TransientError(`notebooklm: ${context} failed to reach sidecar`, {
      cause: error,
    });
  }

  if (response.status === 202 || response.ok) {
    return { status: response.status, response };
  }

  throw await sidecarError(response, context);
}

async function sidecarError(
  response: Response,
  context: string,
): Promise<Error> {
  const detail = await readDetail(response);
  const message = `notebooklm: ${context} -> ${response.status}${
    detail ? ` (${detail})` : ""
  }`;

  switch (response.status) {
    case 429:
      return new QuotaExhaustedError(message, retryAfter(response));
    case 401:
      // Not retryable: the sidecar's NotebookLM session needs a human.
      return new Error(`${message}. Re-authenticate the NotebookLM sidecar.`);
    case 404:
      return new Error(message);
    case 502:
      return new TransientError(message);
    default:
      return response.status >= 500
        ? new TransientError(message)
        : new Error(message);
  }
}

async function readDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

function retryAfter(response: Response): Date | undefined {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Trailing YYYYMMDDHHMM stamp produced by makeJobKey. */
const JOB_KEY_STAMP = /(?:^|:)(\d{12})$/;

/**
 * Notebook title, as a human reads it in the NotebookLM list:
 *
 *     AI News - 2026-09-13 00:49
 *
 * The title is for people and the jobKey is for machines, so they travel
 * separately: the jobKey goes in the create body where the sidecar can key off
 * it. An earlier version embedded the raw jobKey here, which meant a UUID ate
 * the visible width of every row and made one topic's notebooks
 * indistinguishable at a glance.
 *
 * Name plus minute is already unique: makeJobKey stamps to the minute and the
 * digests table has a unique index on jobKey, so two digests for one topic
 * cannot share a minute.
 *
 * Honest limitation: this is only half of idempotency. Whether a retry reuses
 * an existing notebook is the sidecar's call - NotebookLM has no idempotency
 * key. If it does not dedupe, a retry after a mid-render crash leaves an orphan
 * and burns one of the 20 daily audio overviews. A readable title is what makes
 * that orphan findable and cleanable, which is the second reason not to bury it
 * under a UUID.
 */
export function notebookTitle(input: RenderInput): string {
  const stamp = JOB_KEY_STAMP.exec(input.jobKey)?.[1];
  if (!stamp) {
    // An unrecognised jobKey shape still needs a unique, findable title.
    return `${input.topic.name} [${input.jobKey}]`;
  }

  const when =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ` +
    `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}`;
  return `${input.topic.name} - ${when}`;
}

export function createNotebookLmRenderer(
  deps: NotebookLmDeps = defaultNotebookLmDeps,
): RendererPlugin<NotebookLmConfig> {
  return {
    kind: "renderer",
    id: "notebooklm",
    label: "NotebookLM audio overview",
    description:
      "Sends the topic's item URLs to NotebookLM through the sidecar and returns a text summary plus an audio overview mp3.",
    configSchema: notebookLmConfigSchema,
    produces: { text: true, audio: true },
    dailyBudget: NOTEBOOKLM_DAILY_BUDGET,

    async validate(config: NotebookLmConfig): Promise<ValidationResult> {
      const resolved = resolveConfig(config);
      try {
        const { response } = await call(
          deps,
          resolved,
          "/health",
          { method: "GET" },
          "health check",
        );
        return { ok: true, message: `Sidecar healthy (${response.status}).` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async render(
      config: NotebookLmConfig,
      input: RenderInput,
    ): Promise<RenderOutput> {
      if (input.items.length === 0) {
        throw new Error("notebooklm: nothing to render, the item list is empty");
      }
      const resolved = resolveConfig(config);

      const created = await call(
        deps,
        resolved,
        "/notebooks",
        jsonInit({ title: notebookTitle(input), jobKey: input.jobKey }),
        "create notebook",
      );
      const { id } = (await created.response.json()) as { id?: string };
      if (!id) {
        throw new TransientError(
          "notebooklm: sidecar created a notebook without returning an id",
        );
      }

      await call(
        deps,
        resolved,
        `/notebooks/${id}/sources`,
        jsonInit({ urls: input.items.map((item) => item.url) }),
        "add sources",
      );

      const asked = await call(
        deps,
        resolved,
        `/notebooks/${id}/ask`,
        jsonInit({ question: resolved.instructions ?? DEFAULT_QUESTION }),
        "ask for summary",
      );
      const { answer } = (await asked.response.json()) as { answer?: string };
      const summary = (answer ?? "").trim();
      if (summary === "") {
        throw new TransientError("notebooklm: sidecar returned an empty answer");
      }

      await call(
        deps,
        resolved,
        `/notebooks/${id}/audio`,
        jsonInit({ instructions: resolved.instructions }),
        "start audio overview",
      );

      const audio = await pollForAudio(deps, resolved, id);

      const relativePath = `${input.jobKey}.mp3`;
      await deps.writeFile(`${deps.dataDir()}/${relativePath}`, audio);

      const artifacts: Artifact[] = [
        { kind: "text", mime: "text/plain", text: summary },
        {
          kind: "audio",
          mime: "audio/mpeg",
          path: relativePath,
          bytes: audio.byteLength,
        },
      ];
      return { summary, artifacts };
    },
  };
}

/**
 * Polls until the sidecar stops answering 202. The deadline is wall-clock
 * rather than an attempt count so a slow sidecar cannot silently stretch the
 * wait out by an order of magnitude.
 */
async function pollForAudio(
  deps: NotebookLmDeps,
  resolved: ResolvedConfig,
  notebookId: string,
): Promise<Uint8Array> {
  const deadline = deps.now() + resolved.maxPollMs;

  for (;;) {
    const { status, response } = await call(
      deps,
      resolved,
      `/notebooks/${notebookId}/audio`,
      { method: "GET" },
      "poll audio overview",
    );

    if (status !== 202) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        throw new TransientError(
          "notebooklm: sidecar reported the audio ready but sent no bytes",
        );
      }
      return new Uint8Array(buffer);
    }

    if (deps.now() + resolved.pollIntervalMs > deadline) {
      throw new TransientError(
        `notebooklm: audio overview for notebook ${notebookId} was still pending after ${Math.round(
          resolved.maxPollMs / 1000,
        )}s. It may still finish in NotebookLM; the notebook title carries the jobKey.`,
      );
    }
    await deps.sleep(resolved.pollIntervalMs);
  }
}

/** Registry instance. Tests build their own with createNotebookLmRenderer. */
export const notebookLmRenderer = createNotebookLmRenderer();
