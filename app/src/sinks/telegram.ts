import { z } from "zod";
import type {
  Artifact,
  ArtifactKind,
  DeliveryResult,
  DigestView,
  SinkPlugin,
  ValidationResult,
} from "../core/types.js";
import { QuotaExhaustedError, TransientError } from "../core/types.js";

/**
 * Telegram delivery sink.
 *
 * Delivery only - Telegram is not the storage layer, disk is. The reason is a
 * hard asymmetry in the Bot API: a bot may UPLOAD files up to 50 MB, but
 * getFile only serves DOWNLOADS up to 20 MB. Anything we push past 20 MB is
 * therefore write-only from the bot's point of view: we could never read it
 * back to build the podcast feed. So the mp3 on the data volume stays the
 * source of truth and Telegram gets a copy for convenience.
 *
 * Past 50 MB we fail loudly instead of uploading, because the API would reject
 * the request anyway and a clear message beats a 413 from a multipart POST.
 */

export const telegramConfigSchema = z.object({
  botToken: z.string().min(1),
  /** Numeric id or "@channelname". */
  chatId: z.string().min(1),
  /**
   * sendAudio renders an inline player but re-encodes and strips the filename;
   * sendDocument preserves the file byte for byte. Archivers want the latter.
   */
  sendAudioAsDocument: z.boolean().optional(),
});

export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

/** Bot API upload ceiling. Beyond this the request cannot succeed. */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** getFile download ceiling - the reason this sink is not the store. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** sendMessage text limit. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export interface TelegramDeps {
  fetch: typeof fetch;
  /** Reads an artifact off the data volume. Path is relative to dataDir(). */
  readFile(path: string): Promise<Uint8Array>;
  dataDir(): string;
}

async function realReadFile(path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(path));
}

export const defaultTelegramDeps: TelegramDeps = {
  fetch: (...args) => fetch(...args),
  readFile: realReadFile,
  dataDir: () => process.env.DATA_DIR ?? "/data",
};

// ---------------------------------------------------------------------------
// Bot API plumbing
// ---------------------------------------------------------------------------

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface TelegramMessage {
  message_id: number;
}

async function callApi<T>(
  deps: TelegramDeps,
  config: TelegramConfig,
  method: string,
  body: BodyInit,
  headers?: Record<string, string>,
): Promise<T> {
  const url = `https://api.telegram.org/bot${config.botToken}/${method}`;

  let response: Response;
  try {
    response = await deps.fetch(url, { method: "POST", body, headers });
  } catch (error) {
    throw new TransientError(`telegram: ${method} could not be sent`, {
      cause: error,
    });
  }

  const envelope = await readEnvelope<T>(response);

  if (response.ok && envelope?.ok && envelope.result !== undefined) {
    return envelope.result;
  }

  const description = envelope?.description ?? `HTTP ${response.status}`;
  const message = `telegram: ${method} failed - ${description}`;

  // 429 carries the wait in the body, not just in Retry-After.
  if (response.status === 429 || envelope?.error_code === 429) {
    const seconds =
      envelope?.parameters?.retry_after ?? headerSeconds(response, "retry-after");
    return Promise.reject(
      new QuotaExhaustedError(
        message,
        seconds === undefined
          ? undefined
          : new Date(Date.now() + seconds * 1000),
      ),
    );
  }
  if (response.status >= 500) {
    throw new TransientError(message);
  }
  throw new Error(message);
}

async function readEnvelope<T>(
  response: Response,
): Promise<TelegramEnvelope<T> | undefined> {
  try {
    return (await response.json()) as TelegramEnvelope<T>;
  } catch {
    return undefined;
  }
}

function headerSeconds(response: Response, name: string): number | undefined {
  const raw = response.headers?.get?.(name);
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function messageText(digest: DigestView): string {
  const header = `${digest.topicName} - ${digest.itemCount} item${
    digest.itemCount === 1 ? "" : "s"
  }`;
  const full = `${header}\n\n${digest.summary}`;
  return full.length <= TELEGRAM_MAX_MESSAGE_CHARS
    ? full
    : `${full.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 3)}...`;
}

function fileName(artifact: Artifact, digest: DigestView): string {
  const fromPath = artifact.path?.split("/").pop();
  return fromPath && fromPath !== "" ? fromPath : `${digest.id}.mp3`;
}

function describeSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function createTelegramSink(
  deps: TelegramDeps = defaultTelegramDeps,
): SinkPlugin<TelegramConfig> {
  const accepts: ArtifactKind[] = ["text", "audio"];

  return {
    kind: "sink",
    id: "telegram",
    label: "Telegram",
    description:
      "Posts the digest summary to a Telegram chat and attaches the audio overview. Delivery only - the data volume remains the store.",
    configSchema: telegramConfigSchema,
    accepts,

    async validate(config: TelegramConfig): Promise<ValidationResult> {
      try {
        const me = await callApi<{ username?: string }>(
          deps,
          config,
          "getMe",
          JSON.stringify({}),
          { "content-type": "application/json" },
        );
        return { ok: true, message: `Authenticated as @${me.username ?? "?"}.` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async deliver(
      config: TelegramConfig,
      digest: DigestView,
      artifacts: Artifact[],
    ): Promise<DeliveryResult> {
      // The summary goes first: if the audio upload fails the reader still has
      // the digest, and the text message id is what we keep as externalRef.
      const message = await callApi<TelegramMessage>(
        deps,
        config,
        "sendMessage",
        JSON.stringify({
          chat_id: config.chatId,
          text: messageText(digest),
          disable_web_page_preview: true,
        }),
        { "content-type": "application/json" },
      );

      for (const artifact of artifacts) {
        if (artifact.kind !== "audio") continue;
        await sendAudio(deps, config, digest, artifact);
      }

      return { externalRef: String(message.message_id) };
    },
  };
}

async function sendAudio(
  deps: TelegramDeps,
  config: TelegramConfig,
  digest: DigestView,
  artifact: Artifact,
): Promise<void> {
  if (!artifact.path) {
    throw new Error("telegram: audio artifact has no path on the data volume");
  }

  // Check the recorded size first so an oversized file is rejected before it is
  // ever read into memory, let alone uploaded.
  if (
    artifact.bytes !== undefined &&
    artifact.bytes > TELEGRAM_MAX_UPLOAD_BYTES
  ) {
    throw new Error(oversizeMessage(artifact.bytes, artifact.path));
  }

  const data = await deps.readFile(`${deps.dataDir()}/${artifact.path}`);
  if (data.byteLength > TELEGRAM_MAX_UPLOAD_BYTES) {
    throw new Error(oversizeMessage(data.byteLength, artifact.path));
  }

  const method = config.sendAudioAsDocument ? "sendDocument" : "sendAudio";
  const field = config.sendAudioAsDocument ? "document" : "audio";
  const name = fileName(artifact, digest);

  const form = new FormData();
  form.set("chat_id", config.chatId);
  form.set("caption", digest.topicName.slice(0, 1024));
  form.set(
    field,
    new Blob([data as BlobPart], { type: artifact.mime || "audio/mpeg" }),
    name,
  );
  if (!config.sendAudioAsDocument) {
    form.set("title", digest.topicName.slice(0, 64));
  }

  // No content-type header: fetch sets the multipart boundary itself.
  await callApi<TelegramMessage>(deps, config, method, form);
}

function oversizeMessage(bytes: number, path: string): string {
  return (
    `telegram: ${path} is ${describeSize(bytes)}, over the ${describeSize(
      TELEGRAM_MAX_UPLOAD_BYTES,
    )} bot upload limit. ` +
    `Shorten the digest or serve it from the podcast feed instead; note that even under that limit, files over ${describeSize(
      TELEGRAM_MAX_DOWNLOAD_BYTES,
    )} cannot be downloaded back through getFile.`
  );
}

/** Registry instance. Tests build their own with createTelegramSink. */
export const telegramSink = createTelegramSink();
