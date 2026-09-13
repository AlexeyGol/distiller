import type { z } from "zod";

/**
 * Domain + plugin contracts for Distiller.
 *
 * Three pluggable seams, all self-describing so the UI can render config forms
 * without knowing about any concrete plugin:
 *   - SourcePlugin   : where items come from
 *   - RendererPlugin : items -> digest content
 *   - SinkPlugin     : a finished digest -> somewhere it lands
 *
 * A Topic is the unit of organisation: it groups sources, owns the keyword
 * rules, and is what a digest is generated for. One topic == one podcast feed.
 */

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** An item as produced by a source plugin, before it is persisted. */
export interface NormalizedItem {
  /** Stable identifier within the source. Forms the dedup key with sourceId. */
  externalId: string;
  url: string;
  title: string;
  publishedAt: Date;
  /** Text content when the source can supply it (RSS description, etc.). */
  body?: string;
  /** Original payload, retained for debugging and later re-parsing. */
  raw: unknown;
}

/**
 * Opaque per-source resume state. Source plugins use it to avoid refetching:
 * HTTP conditional GET for feeds, publishedAfter for API-backed searches.
 */
export interface Cursor {
  etag?: string;
  lastModified?: string;
  /** ISO-8601. Sources that page by time (e.g. YouTube search) use this. */
  publishedAfter?: string;
  pageToken?: string;
}

// ---------------------------------------------------------------------------
// Plugin manifests
// ---------------------------------------------------------------------------

export type PluginKind = "source" | "renderer" | "sink";

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

/** Common shape every plugin exposes so the UI can list and configure it. */
export interface PluginManifest<C> {
  id: string;
  label: string;
  /** Shown under the label in the "add new" catalog. */
  description: string;
  /**
   * Drives BOTH the generated config form and server-side validation.
   * Persisted instance config is validated against this on read and write.
   */
  configSchema: z.ZodType<C>;
  /** Backs the "Test" button. Must not mutate anything. */
  validate?(config: C): Promise<ValidationResult>;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface FetchResult {
  items: NormalizedItem[];
  /** Persisted verbatim and handed back on the next poll. */
  cursor: Cursor | null;
}

export interface SourcePlugin<C = unknown> extends PluginManifest<C> {
  kind: "source";
  capabilities: {
    /** False for one-shot imports that should not be scheduled. */
    pollable: boolean;
    /** True when the plugin can resume from a Cursor rather than refetching. */
    supportsCursor: boolean;
  };
  fetch(config: C, cursor: Cursor | null): Promise<FetchResult>;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export type ArtifactKind = "text" | "audio";

export interface Artifact {
  kind: ArtifactKind;
  mime: string;
  /** Path relative to the data volume. Set for binary artifacts. */
  path?: string;
  /** Inline content. Set for text artifacts. */
  text?: string;
  bytes?: number;
}

/** What a renderer receives: the topic it is rendering for, plus the items. */
export interface RenderInput {
  topic: {
    id: string;
    name: string;
    /**
     * Unique, URL- and filesystem-safe. Renderers name artifacts from this, so
     * a generated file never carries a raw UUID or a character that is illegal
     * on Windows. Optional only so test doubles stay terse - the pipeline
     * always supplies it.
     */
    slug?: string;
    description?: string;
  };
  items: NormalizedItem[];
  /**
   * Idempotency key. A retry with the same jobKey must not produce a second
   * upstream artifact; renderers that call external services key on this.
   */
  jobKey: string;
}

export interface RenderOutput {
  summary: string;
  artifacts: Artifact[];
}

export interface RendererPlugin<C = unknown> extends PluginManifest<C> {
  kind: "renderer";
  produces: { text: boolean; audio: boolean };
  /**
   * Local safety valve, not a mirror of any upstream quota. Counted against
   * render_log over a configurable window; the upstream's own quota error
   * remains the authoritative signal. Undefined means unmetered.
   */
  dailyBudget?: number;
  render(config: C, input: RenderInput): Promise<RenderOutput>;
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

export interface DigestView {
  id: string;
  topicName: string;
  summary: string;
  createdAt: Date;
  itemCount: number;
}

export interface DeliveryResult {
  /** Upstream id (e.g. a Telegram message id) kept for traceability. */
  externalRef?: string;
}

export interface SinkPlugin<C = unknown> extends PluginManifest<C> {
  kind: "sink";
  accepts: ArtifactKind[];
  deliver(
    config: C,
    digest: DigestView,
    artifacts: Artifact[],
  ): Promise<DeliveryResult>;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

export type AnyPlugin =
  | SourcePlugin<any>
  | RendererPlugin<any>
  | SinkPlugin<any>;

// ---------------------------------------------------------------------------
// Keyword filtering
// ---------------------------------------------------------------------------

export type KeywordMode = "include" | "exclude";

export interface KeywordRule {
  term: string;
  mode: KeywordMode;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by a plugin when the upstream says we are out of quota. The worker
 * treats this as authoritative: trip the circuit breaker and stop enqueueing,
 * regardless of what our own local counter believes.
 */
export class QuotaExhaustedError extends Error {
  readonly retryAfter?: Date;
  constructor(message: string, retryAfter?: Date) {
    super(message);
    this.name = "QuotaExhaustedError";
    this.retryAfter = retryAfter;
  }
}

/** Thrown for upstream failures that are worth retrying later. */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientError";
  }
}
