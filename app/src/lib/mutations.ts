import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  keywords,
  pluginSettings,
  settings,
  sinks,
  sources,
  topicSinks,
  topicSources,
  topics,
  type Keyword,
  type Sink,
  type Source,
  type Topic,
} from "../db/schema.js";
import type { PluginRegistry } from "../core/registry.js";
import { registry } from "../plugins.js";
import { formatZodError } from "./schema-form.js";
import { z } from "zod";

/**
 * Every write the UI performs, as plain functions over a Database handle.
 *
 * The Server Actions in src/app/actions are thin wrappers around these. The
 * split exists so the writes can be tested against a real (pglite) database
 * without booting Next: a "use server" module is an RPC surface, and its
 * exports must not take a Database argument that a browser could supply.
 */

export type CurationMode = "auto" | "manual";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Slugs are unique in the schema; suffix rather than fail on a collision. */
async function uniqueSlug(db: Database, desired: string): Promise<string> {
  const base = desired || "topic";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [clash] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, candidate));
    if (!clash) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface CreateTopicInput {
  name: string;
  slug?: string;
  description?: string | null;
  enabled?: boolean;
  schedule?: string | null;
  curationMode?: CurationMode;
  rendererId?: string;
  rendererConfig?: unknown;
}

export async function createTopic(
  db: Database,
  input: CreateTopicInput,
): Promise<Topic> {
  const name = input.name.trim();
  if (!name) throw new Error("Topic name is required");

  const slug = await uniqueSlug(db, slugify(input.slug?.trim() || name));

  const [row] = await db
    .insert(topics)
    .values({
      name,
      slug,
      description: emptyToNull(input.description),
      enabled: input.enabled ?? true,
      schedule: emptyToNull(input.schedule),
      curationMode: normaliseCuration(input.curationMode),
      ...(input.rendererId ? { rendererId: input.rendererId } : {}),
      ...(input.rendererConfig !== undefined
        ? { rendererConfig: input.rendererConfig }
        : {}),
    })
    .returning();

  return row!;
}

export interface UpdateTopicInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  schedule?: string | null;
  curationMode?: CurationMode;
  rendererId?: string;
  rendererConfig?: unknown;
}

export async function updateTopic(
  db: Database,
  topicId: string,
  patch: UpdateTopicInput,
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Topic name is required");
    values.name = name;
  }
  if (patch.description !== undefined) {
    values.description = emptyToNull(patch.description);
  }
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.schedule !== undefined) values.schedule = emptyToNull(patch.schedule);
  if (patch.curationMode !== undefined) {
    values.curationMode = normaliseCuration(patch.curationMode);
  }
  if (patch.rendererId !== undefined) values.rendererId = patch.rendererId;
  if (patch.rendererConfig !== undefined) {
    values.rendererConfig = patch.rendererConfig;
  }

  if (Object.keys(values).length === 0) return;
  await db.update(topics).set(values).where(eq(topics.id, topicId));
}

export async function deleteTopic(db: Database, topicId: string): Promise<void> {
  await db.delete(topics).where(eq(topics.id, topicId));
}

/**
 * Validate and store a renderer config for a topic. Done here rather than in
 * the page so the same schema that generated the form is what rejects bad input.
 */
export async function setTopicRenderer(
  db: Database,
  topicId: string,
  rendererId: string,
  config: unknown,
  reg: PluginRegistry = registry(),
): Promise<void> {
  const plugin = reg.getRenderer(rendererId);
  if (!plugin) throw new Error(`Unknown renderer plugin: "${rendererId}"`);
  const parsed = parseOrThrow(plugin.configSchema, config, plugin.label);
  await db
    .update(topics)
    .set({ rendererId, rendererConfig: parsed as object })
    .where(eq(topics.id, topicId));
}

// ---------------------------------------------------------------------------
// Topic <-> source / sink links
// ---------------------------------------------------------------------------

export async function attachSource(
  db: Database,
  topicId: string,
  sourceId: string,
): Promise<void> {
  await db
    .insert(topicSources)
    .values({ topicId, sourceId })
    .onConflictDoNothing();
}

export async function detachSource(
  db: Database,
  topicId: string,
  sourceId: string,
): Promise<void> {
  await db
    .delete(topicSources)
    .where(
      and(
        eq(topicSources.topicId, topicId),
        eq(topicSources.sourceId, sourceId),
      ),
    );
}

export async function attachSink(
  db: Database,
  topicId: string,
  sinkId: string,
): Promise<void> {
  await db.insert(topicSinks).values({ topicId, sinkId }).onConflictDoNothing();
}

export async function detachSink(
  db: Database,
  topicId: string,
  sinkId: string,
): Promise<void> {
  await db
    .delete(topicSinks)
    .where(and(eq(topicSinks.topicId, topicId), eq(topicSinks.sinkId, sinkId)));
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

export async function addKeyword(
  db: Database,
  topicId: string,
  term: string,
  mode: string,
): Promise<Keyword> {
  const trimmed = term.trim();
  if (!trimmed) throw new Error("Keyword term is required");

  const [row] = await db
    .insert(keywords)
    .values({
      topicId,
      term: trimmed,
      mode: mode === "exclude" ? "exclude" : "include",
    })
    .returning();
  return row!;
}

export async function removeKeyword(
  db: Database,
  keywordId: string,
): Promise<void> {
  await db.delete(keywords).where(eq(keywords.id, keywordId));
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface CreateSourceInput {
  pluginId: string;
  label: string;
  config: unknown;
  enabled?: boolean;
}

export async function createSource(
  db: Database,
  input: CreateSourceInput,
  reg: PluginRegistry = registry(),
): Promise<Source> {
  const plugin = reg.getSource(input.pluginId);
  if (!plugin) throw new Error(`Unknown source plugin: "${input.pluginId}"`);

  const label = input.label.trim();
  if (!label) throw new Error("Source label is required");

  const config = parseOrThrow(plugin.configSchema, input.config, plugin.label);

  const [row] = await db
    .insert(sources)
    .values({
      pluginId: plugin.id,
      label,
      config: config as object,
      enabled: input.enabled ?? true,
    })
    .returning();
  return row!;
}

export async function updateSourceConfig(
  db: Database,
  sourceId: string,
  label: string,
  config: unknown,
  reg: PluginRegistry = registry(),
): Promise<void> {
  const [existing] = await db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId));
  if (!existing) throw new Error(`Unknown source: ${sourceId}`);

  const plugin = reg.requireSource(existing.pluginId);
  const parsed = parseOrThrow(plugin.configSchema, config, plugin.label);

  await db
    .update(sources)
    .set({ label: label.trim() || existing.label, config: parsed as object })
    .where(eq(sources.id, sourceId));
}

export async function setSourceEnabled(
  db: Database,
  sourceId: string,
  enabled: boolean,
): Promise<void> {
  await db.update(sources).set({ enabled }).where(eq(sources.id, sourceId));
}

export async function deleteSource(
  db: Database,
  sourceId: string,
): Promise<void> {
  await db.delete(sources).where(eq(sources.id, sourceId));
}

/** Backs the "Test" button. Never mutates; returns whatever the plugin says. */
export async function testSourceConfig(
  pluginId: string,
  config: unknown,
  reg: PluginRegistry = registry(),
): Promise<{ ok: boolean; message: string }> {
  const plugin = reg.getSource(pluginId);
  if (!plugin) return { ok: false, message: `Unknown plugin: "${pluginId}"` };

  const parsed = plugin.configSchema.safeParse(config);
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) };
  }
  if (!plugin.validate) {
    return { ok: true, message: "Config is valid. This plugin has no live test." };
  }
  try {
    const result = await plugin.validate(parsed.data);
    return { ok: result.ok, message: result.message ?? (result.ok ? "OK" : "Failed") };
  } catch (cause) {
    return { ok: false, message: describe(cause) };
  }
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

export async function createSink(
  db: Database,
  input: CreateSourceInput,
  reg: PluginRegistry = registry(),
): Promise<Sink> {
  const plugin = reg.getSink(input.pluginId);
  if (!plugin) throw new Error(`Unknown sink plugin: "${input.pluginId}"`);

  const label = input.label.trim();
  if (!label) throw new Error("Sink label is required");

  const config = parseOrThrow(plugin.configSchema, input.config, plugin.label);

  const [row] = await db
    .insert(sinks)
    .values({
      pluginId: plugin.id,
      label,
      config: config as object,
      enabled: input.enabled ?? true,
    })
    .returning();
  return row!;
}

/**
 * Edit an existing sink's label and config.
 *
 * Sinks hold the credentials most likely to need changing: a Telegram bot
 * token gets rotated, a chat id was pasted wrong. Without this the only fix
 * was delete-and-recreate, which also drops the sink's delivery history and
 * detaches it from every topic.
 *
 * Mirrors updateSourceConfig, including not allowing the plugin id to change:
 * a config validated against one plugin's schema is meaningless to another.
 */
export async function updateSinkConfig(
  db: Database,
  sinkId: string,
  label: string,
  config: unknown,
  reg: PluginRegistry = registry(),
): Promise<void> {
  const [existing] = await db.select().from(sinks).where(eq(sinks.id, sinkId));
  if (!existing) throw new Error(`Unknown sink: ${sinkId}`);

  const plugin = reg.requireSink(existing.pluginId);
  const parsed = parseOrThrow(plugin.configSchema, config, plugin.label);

  await db
    .update(sinks)
    .set({ label: label.trim() || existing.label, config: parsed as object })
    .where(eq(sinks.id, sinkId));
}

export async function setSinkEnabled(
  db: Database,
  sinkId: string,
  enabled: boolean,
): Promise<void> {
  await db.update(sinks).set({ enabled }).where(eq(sinks.id, sinkId));
}

export async function deleteSink(db: Database, sinkId: string): Promise<void> {
  await db.delete(sinks).where(eq(sinks.id, sinkId));
}

export async function testSinkConfig(
  pluginId: string,
  config: unknown,
  reg: PluginRegistry = registry(),
): Promise<{ ok: boolean; message: string }> {
  const plugin = reg.getSink(pluginId);
  if (!plugin) return { ok: false, message: `Unknown plugin: "${pluginId}"` };

  const parsed = plugin.configSchema.safeParse(config);
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) };
  }
  if (!plugin.validate) {
    return { ok: true, message: "Config is valid. This plugin has no live test." };
  }
  try {
    const result = await plugin.validate(parsed.data);
    return { ok: result.ok, message: result.message ?? (result.ok ? "OK" : "Failed") };
  } catch (cause) {
    return { ok: false, message: describe(cause) };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  defaultSchedule: string;
  defaultCurationMode: string;
  retentionDays: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultSchedule: "0 7 * * *",
  defaultCurationMode: "manual",
  retentionDays: 30,
};

export async function loadSettings(db: Database): Promise<AppSettings> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.id, "global"));
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    defaultSchedule: row.defaultSchedule,
    defaultCurationMode: row.defaultCurationMode,
    retentionDays: row.retentionDays,
  };
}

export async function saveSettings(
  db: Database,
  patch: Partial<AppSettings>,
): Promise<void> {
  const current = await loadSettings(db);
  const next: AppSettings = {
    defaultSchedule: patch.defaultSchedule?.trim() || current.defaultSchedule,
    defaultCurationMode: normaliseCuration(
      (patch.defaultCurationMode ?? current.defaultCurationMode) as CurationMode,
    ),
    retentionDays:
      patch.retentionDays !== undefined && Number.isFinite(patch.retentionDays)
        ? Math.max(1, Math.trunc(patch.retentionDays))
        : current.retentionDays,
  };

  await db
    .insert(settings)
    .values({ id: "global", ...next })
    .onConflictDoUpdate({ target: settings.id, set: next });
}

/** Type-level plugin toggle: hides the type and pauses all of its instances. */
export async function setPluginEnabled(
  db: Database,
  pluginId: string,
  kind: string,
  enabled: boolean,
): Promise<void> {
  await db
    .insert(pluginSettings)
    .values({ pluginId, kind, enabled })
    .onConflictDoUpdate({
      target: [pluginSettings.pluginId, pluginSettings.kind],
      set: { enabled },
    });
}

export async function loadPluginToggles(
  db: Database,
): Promise<Map<string, boolean>> {
  const rows = await db.select().from(pluginSettings);
  return new Map(rows.map((r) => [`${r.kind}:${r.pluginId}`, r.enabled]));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseOrThrow(
  schema: z.ZodType<unknown>,
  value: unknown,
  label: string,
): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

function normaliseCuration(mode: CurationMode | string | undefined): string {
  return mode === "auto" ? "auto" : "manual";
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
