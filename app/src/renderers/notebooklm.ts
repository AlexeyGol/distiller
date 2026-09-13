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
  /** Per-request timeout for create/sources. Does not bound the audio poll. */
  timeoutMs: z.number().int().positive().optional(),
  /** Budget for the summary generation call, which waits on the model. */
  askTimeoutMs: z.number().int().positive().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  maxPollMs: z.number().int().positive().optional(),
  /** Extra steering passed to NotebookLM's audio overview generator. */
  instructions: z.string().min(1).optional(),
});

export type NotebookLmConfig = z.infer<typeof notebookLmConfigSchema>;

/**
 * Where the sidecar lives when a topic's config does not say.
 *
 * `http://sidecar:8000` is correct inside compose, where the service name
 * resolves on the shared network. It resolves to nothing when `npm run dev`
 * runs on the host, so SIDECAR_URL overrides it - set to
 * `http://localhost:8000` in `.env.local`, alongside the loopback port the
 * compose file publishes for exactly this reason.
 *
 * Read lazily rather than at module load: the env file is loaded by an import
 * in the entry point, and a constant evaluated at import time could win the
 * race depending on module order.
 */
export function defaultBaseUrl(): string {
  return process.env.SIDECAR_URL ?? "http://sidecar:8000";
}

/** @deprecated Prefer defaultBaseUrl(); kept so existing imports still resolve. */
export const DEFAULT_BASE_URL = "http://sidecar:8000";
/**
 * Transport timeout for the quick calls. 30s was too tight even for these:
 * adding four sources measured ~20s, because the sidecar has to upload each URL
 * to NotebookLM and wait for it to be ingested, and that scales with item count.
 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Separate, longer budget for the calls that wait on GENERATION rather than
 * transport. Asking NotebookLM a question runs a streaming model call; the
 * request simply stays open while it thinks. Sharing one timeout with
 * create/sources meant aborting work that was still in progress and reporting
 * it as "failed to reach sidecar" - a transport error message for a
 * patience problem, which sends you looking in the wrong place.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 600_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Audio overviews routinely take several minutes to generate. */
export const DEFAULT_MAX_POLL_MS = 15 * 60_000;

/** NotebookLM Pro allows 20 audio overviews per day. */
export const NOTEBOOKLM_DAILY_BUDGET = 20;

/**
 * NotebookLM Pro allows roughly 500 chat queries per day, against 20 audio
 * overviews. Asking for a summary is cheap; generating a podcast is not, which
 * is the whole reason the text-only renderer exists as a separate choice.
 *
 * Reported limits, not contractual ones, and Google has been changing the
 * accounting model - so this stays a local safety valve and the sidecar's own
 * 429 remains authoritative.
 */
export const NOTEBOOKLM_ASK_DAILY_BUDGET = 500;

export const DEFAULT_QUESTION =
  "Summarise these sources as a single spoken-word digest: lead with what matters most, group related items, and skip anything without substance.";

interface ResolvedConfig {
  baseUrl: string;
  timeoutMs: number;
  askTimeoutMs: number;
  pollIntervalMs: number;
  maxPollMs: number;
  instructions?: string;
}

function resolveConfig(config: NotebookLmConfig): ResolvedConfig {
  return {
    baseUrl: (config.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, ""),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    askTimeoutMs: config.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
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
  /** Overrides the default for calls that wait on generation, not transport. */
  timeoutMs: number = resolved.timeoutMs,
): Promise<SidecarResponse> {
  let response: Response;
  try {
    response = await deps.fetch(`${resolved.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Reduce a topic name to something safe to put in a path. Applied even to the
 * stored slug, which is user-entered and therefore not trustworthy as a path
 * segment.
 */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "topic"
  );
}

/**
 * Name the mp3 for a human, not for the database:
 *
 *     ai-news-2026-09-13-0049.mp3
 *
 * This name is more visible than it looks. Telegram shows a file's basename as
 * its display name in the chat, and the artifact is downloadable from the UI,
 * so it ends up in real file managers. The previous form was
 * "<jobKey>.mp3", which embedded a UUID and - worse - a colon, which is an
 * illegal filename character on Windows and would break the moment anyone saved
 * the file there.
 *
 * Uniqueness is preserved: topic slugs are unique in the database and the stamp
 * is per-minute, which is exactly the granularity jobKey guarantees.
 */
export function audioFileName(input: RenderInput): string {
  const base = slugify(input.topic.slug ?? input.topic.name);
  const stamp = JOB_KEY_STAMP.exec(input.jobKey)?.[1];

  if (!stamp) {
    // Unrecognised key shape: fall back to a sanitised key so the name stays
    // unique, rather than risking two digests overwriting each other's audio.
    return `${base}-${slugify(input.jobKey)}.mp3`;
  }

  const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  return `${base}-${date}-${stamp.slice(8, 12)}.mp3`;
}

/**
 * Create the notebook, load the item URLs as sources, and ask for a summary.
 *
 * Shared by both NotebookLM renderers. This is the whole of the text-only
 * renderer and the first half of the audio one, and it is the part that makes
 * a NotebookLM summary worth having: the answer is grounded in the sources the
 * notebook actually ingested, rather than in whatever text we managed to
 * scrape and paste into a prompt.
 */
async function createAndSummarise(
  deps: NotebookLmDeps,
  resolved: ResolvedConfig,
  input: RenderInput,
): Promise<{ notebookId: string; summary: string }> {
  if (input.items.length === 0) {
    throw new Error("notebooklm: nothing to render, the item list is empty");
  }

  const created = await call(
    deps,
    resolved,
    "/notebooks",
    jsonInit({ title: notebookTitle(input), jobKey: input.jobKey }),
    "create notebook",
  );
  // The sidecar returns `notebook_id`, matching its own `/notebooks/{notebook_id}`
  // path. `id` is accepted as a fallback so a different adapter - the official
  // Gemini Notebook API, say - can be dropped in without editing this.
  //
  // These two halves were built to briefs that disagreed on this field name.
  // Both sides' unit tests passed, because each mocked its own assumption; the
  // mismatch only appeared the first time real HTTP crossed between them. Hence
  // the contract test alongside this.
  const payload = (await created.response.json()) as {
    notebook_id?: string;
    id?: string;
  };
  const id = payload.notebook_id ?? payload.id;
  if (!id) {
    throw new TransientError(
      "notebooklm: sidecar created a notebook but returned neither " +
        `notebook_id nor id (got: ${JSON.stringify(payload).slice(0, 120)})`,
    );
  }

  // Everything after the notebook exists is wrapped, so a failure cleans up
  // after itself. Without this each failed attempt abandoned a notebook: four
  // debugging runs left four identically-titled orphans, and NotebookLM caps
  // an account at 500. One digest should mean one notebook, which means the
  // renderer has to own the lifecycle of what it creates, not just create it.
  try {
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
    resolved.askTimeoutMs,
  );
    const { answer } = (await asked.response.json()) as { answer?: string };
    const summary = (answer ?? "").trim();
    if (summary === "") {
      throw new TransientError("notebooklm: sidecar returned an empty answer");
    }

    return { notebookId: id, summary };
  } catch (error) {
    await discardNotebook(deps, resolved, id);
    throw error;
  }
}

/**
 * Best-effort delete of a notebook we created but could not finish with.
 *
 * Deliberately swallows its own failure: the caller is already throwing the
 * error that actually matters, and replacing it with "cleanup failed" would
 * hide the real cause. A surviving orphan is findable by its readable title.
 */
async function discardNotebook(
  deps: NotebookLmDeps,
  resolved: ResolvedConfig,
  notebookId: string,
): Promise<void> {
  try {
    await call(
      deps,
      resolved,
      `/notebooks/${notebookId}`,
      { method: "DELETE" },
      "discard notebook",
    );
  } catch {
    // Intentionally ignored - see above.
  }
}

async function sidecarHealth(
  deps: NotebookLmDeps,
  config: NotebookLmConfig,
): Promise<ValidationResult> {
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
}

/**
 * Text-only NotebookLM renderer.
 *
 * Exists because the two NotebookLM capabilities have very different costs.
 * An audio overview is one of 20 per day on a Pro account and takes minutes;
 * asking a question is one of roughly 500 per day and returns in seconds.
 * Without this plugin the only way to get a source-grounded NotebookLM summary
 * was to generate a podcast you did not want, spending 5% of the daily audio
 * budget to obtain a paragraph of text.
 *
 * Use it for topics you want to read rather than listen to, and to keep the
 * audio budget for the topics that are actually worth a podcast.
 */
export function createNotebookLmTextRenderer(
  deps: NotebookLmDeps = defaultNotebookLmDeps,
): RendererPlugin<NotebookLmConfig> {
  return {
    kind: "renderer",
    id: "notebooklm-text",
    label: "NotebookLM summary (text only)",
    description:
      "Sends the topic's item URLs to NotebookLM and returns just the grounded text summary. No audio, so it does not touch the 20-per-day audio overview budget.",
    configSchema: notebookLmConfigSchema,
    produces: { text: true, audio: false },
    dailyBudget: NOTEBOOKLM_ASK_DAILY_BUDGET,

    validate: (config: NotebookLmConfig) => sidecarHealth(deps, config),

    async render(
      config: NotebookLmConfig,
      input: RenderInput,
    ): Promise<RenderOutput> {
      const resolved = resolveConfig(config);
      const { summary } = await createAndSummarise(deps, resolved, input);

      return {
        summary,
        artifacts: [{ kind: "text", mime: "text/plain", text: summary }],
      };
    },
  };
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

    validate: (config: NotebookLmConfig) => sidecarHealth(deps, config),

    async render(
      config: NotebookLmConfig,
      input: RenderInput,
    ): Promise<RenderOutput> {
      const resolved = resolveConfig(config);
      const { notebookId: id, summary } = await createAndSummarise(
        deps,
        resolved,
        input,
      );

      await call(
        deps,
        resolved,
        `/notebooks/${id}/audio`,
        jsonInit({ instructions: resolved.instructions }),
        "start audio overview",
      );

      const audio = await pollForAudio(deps, resolved, id);

      const relativePath = audioFileName(input);
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

export const notebookLmTextRenderer = createNotebookLmTextRenderer();
