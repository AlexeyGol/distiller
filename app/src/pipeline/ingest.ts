import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { items, sources, type Source } from "../db/schema.js";
import type { PluginRegistry } from "../core/registry.js";
import type { Cursor, NormalizedItem } from "../core/types.js";

export interface IngestResult {
  sourceId: string;
  /** Items the source returned this poll. */
  fetched: number;
  /** Items actually written. Lower than `fetched` when the feed repeats items. */
  inserted: number;
  /** Set when the poll failed. The source is not retried within this run. */
  error?: string;
}

export interface IngestDeps {
  db: Database;
  registry: PluginRegistry;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

/**
 * Poll one source and persist whatever is new.
 *
 * Two invariants this function exists to uphold:
 *
 *  1. **Dedup is the database's job, not ours.** We insert with
 *     ON CONFLICT DO NOTHING against the (source_id, external_id) unique
 *     index rather than SELECT-then-INSERT. Checking first would still race
 *     two concurrent workers; the constraint cannot.
 *
 *  2. **A failing source must not poison the run.** Errors are recorded on
 *     the source row and returned, never thrown, so one dead feed does not
 *     stop the other twenty.
 */
export async function ingestSource(
  deps: IngestDeps,
  source: Source,
): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date());
  const plugin = deps.registry.getSource(source.pluginId);

  if (!plugin) {
    // A stored row referencing an unknown plugin means the row outlived the
    // build that wrote it. Record it loudly rather than skipping in silence.
    const error = `Unknown source plugin: "${source.pluginId}"`;
    await markFailure(deps.db, source.id, error, now());
    return { sourceId: source.id, fetched: 0, inserted: 0, error };
  }

  let config: unknown;
  try {
    config = plugin.configSchema.parse(source.config);
  } catch (cause) {
    const error = `Invalid config: ${describeError(cause)}`;
    await markFailure(deps.db, source.id, error, now());
    return { sourceId: source.id, fetched: 0, inserted: 0, error };
  }

  let fetched: NormalizedItem[];
  let nextCursor: Cursor | null;
  try {
    const result = await plugin.fetch(config, (source.cursor as Cursor) ?? null);
    fetched = result.items;
    nextCursor = result.cursor;
  } catch (cause) {
    const error = describeError(cause);
    await markFailure(deps.db, source.id, error, now());
    return { sourceId: source.id, fetched: 0, inserted: 0, error };
  }

  const inserted = await insertNewItems(deps.db, source.id, fetched);

  await deps.db
    .update(sources)
    .set({ cursor: nextCursor, lastPolledAt: now(), lastError: null })
    .where(eq(sources.id, source.id));

  return { sourceId: source.id, fetched: fetched.length, inserted };
}

/**
 * Insert items, skipping ones already stored. Returns how many were new,
 * which is what the UI shows as "3 new items" after a poll.
 */
export async function insertNewItems(
  db: Database,
  sourceId: string,
  incoming: readonly NormalizedItem[],
): Promise<number> {
  if (incoming.length === 0) return 0;

  // A source can legitimately return the same externalId twice in one page
  // (badly generated feeds do this). Collapse before hitting the database so
  // the multi-row insert does not self-conflict.
  const unique = new Map<string, NormalizedItem>();
  for (const item of incoming) {
    if (item.externalId) unique.set(item.externalId, item);
  }
  if (unique.size === 0) return 0;

  const rows = await db
    .insert(items)
    .values(
      [...unique.values()].map((item) => ({
        sourceId,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        publishedAt: item.publishedAt,
        body: item.body ?? null,
        raw: item.raw ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: items.id });

  return rows.length;
}

/** Poll every enabled source, isolating failures from each other. */
export async function ingestAll(deps: IngestDeps): Promise<IngestResult[]> {
  const enabled = await deps.db
    .select()
    .from(sources)
    .where(eq(sources.enabled, true));

  const results: IngestResult[] = [];
  for (const source of enabled) {
    results.push(await ingestSource(deps, source));
  }
  return results;
}

async function markFailure(
  db: Database,
  sourceId: string,
  error: string,
  at: Date,
): Promise<void> {
  await db
    .update(sources)
    .set({ lastError: error, lastPolledAt: at })
    .where(eq(sources.id, sourceId));
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
