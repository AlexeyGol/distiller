import { eq } from "drizzle-orm";
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
} from "../db/schema.js";
import { registry } from "../plugins.js";
import type { PluginRegistry } from "../core/registry.js";
import { isSecretField } from "./config-display.js";

/**
 * Export and import the whole configuration: topics, sources, sinks, keywords,
 * settings and plugin toggles.
 *
 * Deliberately NOT a database dump. A dump is machine-to-machine and opaque;
 * this is meant to be read, diffed, committed and moved between installs, so it
 * is keyed on natural identifiers (topic slug, source label) rather than UUIDs.
 * The same file therefore imports onto a different database without collisions.
 *
 * Explicitly excluded: items, digests, artifacts, deliveries, render_log. That
 * is accumulated history, not configuration, and it belongs in `pg_dump`.
 */

export const CONFIG_VERSION = 1;

/** Placeholder written in place of a secret when secrets are not exported. */
export const REDACTED = "__REDACTED__";

export interface ExportedTopic {
  name: string;
  slug: string;
  description: string | null;
  enabled: boolean;
  schedule: string | null;
  curationMode: string;
  rendererId: string;
  rendererConfig: unknown;
  keywords: Array<{ term: string; mode: string }>;
  /** Source labels, not ids - labels survive a move between installs. */
  sources: string[];
  sinks: string[];
}

export interface ExportedInstance {
  label: string;
  pluginId: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface ConfigBundle {
  version: number;
  exportedAt: string;
  /** False when secret-shaped fields were replaced with REDACTED. */
  secretsIncluded: boolean;
  settings: {
    defaultSchedule: string;
    defaultCurationMode: string;
    retentionDays: number;
  } | null;
  pluginSettings: Array<{ pluginId: string; kind: string; enabled: boolean }>;
  sources: ExportedInstance[];
  sinks: ExportedInstance[];
  topics: ExportedTopic[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Replace credential-shaped values with a placeholder.
 *
 * Reuses the same field-name matching as the UI's masking, so a field hidden on
 * screen is also redacted in a file. One rule, two surfaces: if we ever teach
 * the UI about a new credential name, the export learns it too.
 */
export function redactConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    // An empty value carries no secret, and preserving it tells the reader the
    // field exists but was never filled in.
    out[key] =
      isSecretField(key) && value !== "" && value != null ? REDACTED : value;
  }
  return out;
}

export interface ExportOptions {
  /**
   * Include real credential values. Defaults to FALSE.
   *
   * The default is the safe one because the common uses - sharing a setup,
   * committing it, pasting it into an issue - must not leak a bot token. Taking
   * a restorable backup is the deliberate case, so it is the one that needs a
   * flag.
   */
  includeSecrets?: boolean;
  now?: () => Date;
}

export async function exportConfig(
  db: Database,
  options: ExportOptions = {},
): Promise<ConfigBundle> {
  const includeSecrets = options.includeSecrets ?? false;
  const now = options.now ?? (() => new Date());

  const prepare = (config: unknown): Record<string, unknown> => {
    const object =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {};
    return includeSecrets ? object : redactConfig(object);
  };

  const [settingsRow] = await db.select().from(settings);
  const sourceRows = await db.select().from(sources).orderBy(sources.label);
  const sinkRows = await db.select().from(sinks).orderBy(sinks.label);
  const topicRows = await db.select().from(topics).orderBy(topics.slug);
  const pluginRows = await db.select().from(pluginSettings);

  const sourceLabelById = new Map(sourceRows.map((r) => [r.id, r.label]));
  const sinkLabelById = new Map(sinkRows.map((r) => [r.id, r.label]));

  const exportedTopics: ExportedTopic[] = [];
  for (const topic of topicRows) {
    const keywordRows = await db
      .select()
      .from(keywords)
      .where(eq(keywords.topicId, topic.id));
    const sourceLinks = await db
      .select()
      .from(topicSources)
      .where(eq(topicSources.topicId, topic.id));
    const sinkLinks = await db
      .select()
      .from(topicSinks)
      .where(eq(topicSinks.topicId, topic.id));

    exportedTopics.push({
      name: topic.name,
      slug: topic.slug,
      description: topic.description,
      enabled: topic.enabled,
      schedule: topic.schedule,
      curationMode: topic.curationMode,
      rendererId: topic.rendererId,
      rendererConfig: prepare(topic.rendererConfig),
      keywords: keywordRows
        .map((k) => ({ term: k.term, mode: k.mode }))
        .sort((a, b) => a.term.localeCompare(b.term)),
      sources: sourceLinks
        .map((l) => sourceLabelById.get(l.sourceId))
        .filter((l): l is string => l !== undefined)
        .sort(),
      sinks: sinkLinks
        .map((l) => sinkLabelById.get(l.sinkId))
        .filter((l): l is string => l !== undefined)
        .sort(),
    });
  }

  return {
    version: CONFIG_VERSION,
    exportedAt: now().toISOString(),
    secretsIncluded: includeSecrets,
    settings: settingsRow
      ? {
          defaultSchedule: settingsRow.defaultSchedule,
          defaultCurationMode: settingsRow.defaultCurationMode,
          retentionDays: settingsRow.retentionDays,
        }
      : null,
    pluginSettings: pluginRows
      .map((p) => ({ pluginId: p.pluginId, kind: p.kind, enabled: p.enabled }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
    sources: sourceRows.map((s) => ({
      label: s.label,
      pluginId: s.pluginId,
      config: prepare(s.config),
      enabled: s.enabled,
    })),
    sinks: sinkRows.map((s) => ({
      label: s.label,
      pluginId: s.pluginId,
      config: prepare(s.config),
      enabled: s.enabled,
    })),
    topics: exportedTopics,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportResult {
  sources: { created: number; updated: number };
  sinks: { created: number; updated: number };
  topics: { created: number; updated: number };
  /** Non-fatal problems: unknown plugins, unresolved links, missing secrets. */
  warnings: string[];
}

export interface ImportOptions {
  registry?: PluginRegistry;
  /**
   * Reject the bundle if any redacted field has no existing value to keep.
   * Off by default so a redacted bundle can seed a new install and have its
   * keys filled in through the UI afterwards.
   */
  requireSecrets?: boolean;
}

/**
 * Merge a bundle into the database. Upserts by natural key and never deletes:
 * an import adds and updates, so importing a partial bundle cannot silently
 * destroy something it does not mention.
 */
export async function importConfig(
  db: Database,
  bundle: ConfigBundle,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const reg = options.registry ?? registry();
  const warnings: string[] = [];
  const result: ImportResult = {
    sources: { created: 0, updated: 0 },
    sinks: { created: 0, updated: 0 },
    topics: { created: 0, updated: 0 },
    warnings,
  };

  if (bundle.version !== CONFIG_VERSION) {
    throw new Error(
      `Unsupported config version ${bundle.version} (this build reads ${CONFIG_VERSION})`,
    );
  }

  /**
   * Carry forward an existing secret wherever the bundle holds a placeholder.
   * This is what makes a redacted export useful: re-importing it onto a live
   * install updates everything else and leaves the real keys untouched.
   */
  const mergeSecrets = (
    incoming: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
    where: string,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...incoming };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== REDACTED) continue;
      const kept = existing?.[key];
      if (kept === undefined || kept === "") {
        warnings.push(
          `${where}: "${key}" was redacted in the bundle and has no existing value - set it in the UI`,
        );
        delete out[key];
      } else {
        out[key] = kept;
      }
    }
    return out;
  };

  if (options.requireSecrets && !bundle.secretsIncluded) {
    throw new Error(
      "Bundle was exported without secrets and requireSecrets is set",
    );
  }

  // --- settings -----------------------------------------------------------
  if (bundle.settings) {
    await db.insert(settings).values({ id: "global" }).onConflictDoNothing();
    await db.update(settings).set(bundle.settings);
  }

  // --- plugin toggles -----------------------------------------------------
  for (const toggle of bundle.pluginSettings) {
    await db
      .insert(pluginSettings)
      .values(toggle)
      .onConflictDoUpdate({
        target: [pluginSettings.pluginId, pluginSettings.kind],
        set: { enabled: toggle.enabled },
      });
  }

  // --- sources and sinks --------------------------------------------------
  const sourceIdByLabel = new Map<string, string>();
  for (const item of bundle.sources) {
    const plugin = reg.getSource(item.pluginId);
    if (!plugin) {
      warnings.push(
        `source "${item.label}": unknown plugin "${item.pluginId}", skipped`,
      );
      continue;
    }

    const [existing] = await db
      .select()
      .from(sources)
      .where(eq(sources.label, item.label));

    const merged = mergeSecrets(
      item.config,
      existing?.config as Record<string, unknown> | undefined,
      `source "${item.label}"`,
    );

    const parsed = plugin.configSchema.safeParse(merged);
    if (!parsed.success) {
      warnings.push(
        `source "${item.label}": config is invalid for ${item.pluginId} (${parsed.error.issues[0]?.message ?? "unknown"}), skipped`,
      );
      continue;
    }

    if (existing) {
      await db
        .update(sources)
        .set({ config: parsed.data as object, enabled: item.enabled })
        .where(eq(sources.id, existing.id));
      sourceIdByLabel.set(item.label, existing.id);
      result.sources.updated += 1;
    } else {
      const [row] = await db
        .insert(sources)
        .values({
          label: item.label,
          pluginId: item.pluginId,
          config: parsed.data as object,
          enabled: item.enabled,
        })
        .returning();
      sourceIdByLabel.set(item.label, row!.id);
      result.sources.created += 1;
    }
  }

  const sinkIdByLabel = new Map<string, string>();
  for (const item of bundle.sinks) {
    const plugin = reg.getSink(item.pluginId);
    if (!plugin) {
      warnings.push(
        `sink "${item.label}": unknown plugin "${item.pluginId}", skipped`,
      );
      continue;
    }

    const [existing] = await db
      .select()
      .from(sinks)
      .where(eq(sinks.label, item.label));

    const merged = mergeSecrets(
      item.config,
      existing?.config as Record<string, unknown> | undefined,
      `sink "${item.label}"`,
    );

    const parsed = plugin.configSchema.safeParse(merged);
    if (!parsed.success) {
      warnings.push(
        `sink "${item.label}": config is invalid for ${item.pluginId}, skipped`,
      );
      continue;
    }

    if (existing) {
      await db
        .update(sinks)
        .set({ config: parsed.data as object, enabled: item.enabled })
        .where(eq(sinks.id, existing.id));
      sinkIdByLabel.set(item.label, existing.id);
      result.sinks.updated += 1;
    } else {
      const [row] = await db
        .insert(sinks)
        .values({
          label: item.label,
          pluginId: item.pluginId,
          config: parsed.data as object,
          enabled: item.enabled,
        })
        .returning();
      sinkIdByLabel.set(item.label, row!.id);
      result.sinks.created += 1;
    }
  }

  // --- topics -------------------------------------------------------------
  for (const item of bundle.topics) {
    const [existing] = await db
      .select()
      .from(topics)
      .where(eq(topics.slug, item.slug));

    const renderer = reg.getRenderer(item.rendererId);
    if (!renderer) {
      warnings.push(
        `topic "${item.slug}": unknown renderer "${item.rendererId}", keeping it but it will not render`,
      );
    }

    const rendererConfig = mergeSecrets(
      (item.rendererConfig ?? {}) as Record<string, unknown>,
      existing?.rendererConfig as Record<string, unknown> | undefined,
      `topic "${item.slug}" renderer`,
    );

    const values = {
      name: item.name,
      slug: item.slug,
      description: item.description,
      enabled: item.enabled,
      schedule: item.schedule,
      curationMode: item.curationMode,
      rendererId: item.rendererId,
      rendererConfig: rendererConfig as object,
    };

    let topicId: string;
    if (existing) {
      await db.update(topics).set(values).where(eq(topics.id, existing.id));
      topicId = existing.id;
      result.topics.updated += 1;
    } else {
      const [row] = await db.insert(topics).values(values).returning();
      topicId = row!.id;
      result.topics.created += 1;
    }

    // Keywords and links are replaced wholesale: they are small, and the
    // bundle is the intended state for this topic. Merging them would make
    // removing a keyword impossible through an import.
    await db.delete(keywords).where(eq(keywords.topicId, topicId));
    if (item.keywords.length > 0) {
      await db
        .insert(keywords)
        .values(item.keywords.map((k) => ({ topicId, ...k })));
    }

    await db.delete(topicSources).where(eq(topicSources.topicId, topicId));
    for (const label of item.sources) {
      const sourceId =
        sourceIdByLabel.get(label) ??
        (await db.select().from(sources).where(eq(sources.label, label)))[0]?.id;
      if (!sourceId) {
        warnings.push(
          `topic "${item.slug}": source "${label}" not found, link skipped`,
        );
        continue;
      }
      await db
        .insert(topicSources)
        .values({ topicId, sourceId })
        .onConflictDoNothing();
    }

    await db.delete(topicSinks).where(eq(topicSinks.topicId, topicId));
    for (const label of item.sinks) {
      const sinkId =
        sinkIdByLabel.get(label) ??
        (await db.select().from(sinks).where(eq(sinks.label, label)))[0]?.id;
      if (!sinkId) {
        warnings.push(
          `topic "${item.slug}": sink "${label}" not found, link skipped`,
        );
        continue;
      }
      await db
        .insert(topicSinks)
        .values({ topicId, sinkId })
        .onConflictDoNothing();
    }
  }

  return result;
}
