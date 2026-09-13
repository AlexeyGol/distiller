import { and, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  artifacts as artifactsTable,
  deliveries,
  digestItems,
  digests,
  items,
  keywords,
  renderLog,
  sinks,
  topicSinks,
  topicSources,
  topics,
  type Topic,
} from "../db/schema.js";
import type { PluginRegistry } from "../core/registry.js";
import { explainMatch } from "../core/filter.js";
import { resolveEnvRefs } from "../lib/env-ref.js";
import {
  QuotaExhaustedError,
  type KeywordRule,
  type NormalizedItem,
} from "../core/types.js";

export type DigestStatus =
  | "draft"
  | "approved"
  | "rendering"
  | "ready"
  | "failed";

export interface DigestDeps {
  db: Database;
  registry: PluginRegistry;
  now?: () => Date;
}

export interface BuildDraftResult {
  digestId: string | null;
  /** Items considered before keyword filtering. */
  candidates: number;
  /** Items that passed the topic's keyword rules. */
  matched: number;
  reason?: "no-items" | "no-matches";
}

/**
 * Collect everything new for a topic into a DRAFT digest.
 *
 * Candidate set = items from the topic's sources that are not already
 * attached to one of this topic's digests. Membership is per-topic, so the
 * same article can legitimately appear in the "AI" digest and the "Rust"
 * digest without either blocking the other.
 */
export async function buildDraft(
  deps: DigestDeps,
  topicId: string,
): Promise<BuildDraftResult> {
  const now = deps.now ?? (() => new Date());
  const topic = await requireTopic(deps.db, topicId);

  const candidates = await selectCandidateItems(deps.db, topicId);
  if (candidates.length === 0) {
    return { digestId: null, candidates: 0, matched: 0, reason: "no-items" };
  }

  const rules = await loadKeywordRules(deps.db, topicId);
  const matched = candidates.filter(
    (row) => explainMatch(toNormalized(row), rules).matched,
  );

  if (matched.length === 0) {
    // Nothing matched, but the candidates were still "seen". We deliberately
    // do NOT record them anywhere: leaving them unattached means a later
    // keyword change can still pick them up, which is what a user editing
    // their filters expects.
    return {
      digestId: null,
      candidates: candidates.length,
      matched: 0,
      reason: "no-matches",
    };
  }

  const [digest] = await deps.db
    .insert(digests)
    .values({
      topicId,
      jobKey: makeJobKey(topicId, now()),
      rendererId: topic.rendererId,
      status: topic.curationMode === "auto" ? "approved" : "draft",
    })
    .returning();

  await deps.db.insert(digestItems).values(
    matched.map((row) => ({
      digestId: digest!.id,
      itemId: row.id,
      included: true,
    })),
  );

  return {
    digestId: digest!.id,
    candidates: candidates.length,
    matched: matched.length,
  };
}

/** Toggle one item in a draft. This is the curation gate in action. */
export async function setItemIncluded(
  db: Database,
  digestId: string,
  itemId: string,
  included: boolean,
): Promise<void> {
  await db
    .update(digestItems)
    .set({ included })
    .where(
      and(eq(digestItems.digestId, digestId), eq(digestItems.itemId, itemId)),
    );
}

/**
 * Move a draft to approved so it becomes eligible for rendering.
 * Refuses an empty selection: rendering nothing wastes the scarce resource
 * this gate exists to protect.
 */
export async function approveDigest(
  db: Database,
  digestId: string,
): Promise<void> {
  const digest = await requireDigest(db, digestId);
  if (digest.status !== "draft") {
    throw new Error(
      `Cannot approve digest in status "${digest.status}" (expected "draft")`,
    );
  }

  const included = await db
    .select({ id: digestItems.itemId })
    .from(digestItems)
    .where(
      and(eq(digestItems.digestId, digestId), eq(digestItems.included, true)),
    );

  if (included.length === 0) {
    throw new Error("Cannot approve a digest with no included items");
  }

  await db
    .update(digests)
    .set({ status: "approved" })
    .where(eq(digests.id, digestId));
}

/**
 * How many renders this renderer has done inside `windowHours`.
 *
 * Reads the render_log event table rather than a pre-aggregated counter,
 * because the upstream quota window is not ours to define and has been
 * reported both as a rolling 24h window and as a multi-hour compute budget.
 * A log answers either question by changing the interval.
 */
export async function rendersInWindow(
  db: Database,
  rendererId: string,
  windowHours: number,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - windowHours * 3600_000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(renderLog)
    .where(
      and(
        eq(renderLog.rendererId, rendererId),
        gte(renderLog.createdAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

export interface RenderResult {
  status: "ready" | "failed" | "skipped";
  reason?: string;
}

/**
 * Render an approved digest.
 *
 * The local budget is a safety valve, not a mirror of the upstream quota:
 * we stop early if our own count says we are over, but a QuotaExhaustedError
 * from the renderer is treated as authoritative regardless of what we counted.
 */
export async function renderDigest(
  deps: DigestDeps,
  digestId: string,
): Promise<RenderResult> {
  const now = deps.now ?? (() => new Date());
  const digest = await requireDigest(deps.db, digestId);

  if (digest.status !== "approved") {
    return {
      status: "skipped",
      reason: `status is "${digest.status}", expected "approved"`,
    };
  }

  const renderer = deps.registry.requireRenderer(digest.rendererId);
  const topic = await requireTopic(deps.db, digest.topicId);

  if (renderer.dailyBudget !== undefined) {
    const used = await rendersInWindow(
      deps.db,
      renderer.id,
      24,
      now(),
    );
    if (used >= renderer.dailyBudget) {
      return {
        status: "skipped",
        reason: `local budget reached (${used}/${renderer.dailyBudget} in 24h)`,
      };
    }
  }

  const selected = await loadIncludedItems(deps.db, digestId);
  if (selected.length === 0) {
    return { status: "skipped", reason: "no included items" };
  }

  await deps.db
    .update(digests)
    .set({ status: "rendering" })
    .where(eq(digests.id, digestId));

  try {
    const config = renderer.configSchema.parse(
      resolveEnvRefs(topic.rendererConfig ?? {}),
    );
    const output = await renderer.render(config, {
      topic: {
        id: topic.id,
        name: topic.name,
        slug: topic.slug,
        description: topic.description ?? undefined,
      },
      items: selected,
      jobKey: digest.jobKey,
    });

    if (output.artifacts.length > 0) {
      await deps.db.insert(artifactsTable).values(
        output.artifacts.map((a) => ({
          digestId,
          kind: a.kind,
          mime: a.mime,
          path: a.path ?? null,
          text: a.text ?? null,
          bytes: a.bytes ?? null,
        })),
      );
    }

    // Logged only on success: a failed attempt did not consume upstream quota,
    // and counting it would throttle us for no reason.
    await deps.db
      .insert(renderLog)
      .values({ rendererId: renderer.id, digestId });

    await deps.db
      .update(digests)
      .set({ status: "ready", summary: output.summary, renderedAt: now(), error: null })
      .where(eq(digests.id, digestId));

    return { status: "ready" };
  } catch (cause) {
    const reason =
      cause instanceof QuotaExhaustedError
        ? `quota exhausted upstream: ${cause.message}`
        : cause instanceof Error
          ? cause.message
          : String(cause);

    await deps.db
      .update(digests)
      .set({ status: "failed", error: reason })
      .where(eq(digests.id, digestId));

    return { status: "failed", reason };
  }
}

export interface DeliveryOutcome {
  sinkId: string;
  status: "delivered" | "failed";
  externalRef?: string;
  error?: string;
}

/**
 * Deliver a ready digest to every enabled sink attached to its topic.
 * Each sink is tracked separately so a retry only re-attempts what failed.
 */
export async function deliverDigest(
  deps: DigestDeps,
  digestId: string,
): Promise<DeliveryOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const digest = await requireDigest(deps.db, digestId);
  if (digest.status !== "ready") {
    throw new Error(
      `Cannot deliver digest in status "${digest.status}" (expected "ready")`,
    );
  }

  const topic = await requireTopic(deps.db, digest.topicId);
  const targets = await deps.db
    .select({ sink: sinks })
    .from(topicSinks)
    .innerJoin(sinks, eq(sinks.id, topicSinks.sinkId))
    .where(and(eq(topicSinks.topicId, topic.id), eq(sinks.enabled, true)));

  const stored = await deps.db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.digestId, digestId));

  const itemCount = (await loadIncludedItems(deps.db, digestId)).length;
  const outcomes: DeliveryOutcome[] = [];

  for (const { sink } of targets) {
    const plugin = deps.registry.getSink(sink.pluginId);
    if (!plugin) {
      outcomes.push({
        sinkId: sink.id,
        status: "failed",
        error: `Unknown sink plugin: "${sink.pluginId}"`,
      });
      continue;
    }

    try {
      const config = plugin.configSchema.parse(resolveEnvRefs(sink.config));
      const accepted = stored.filter((a) =>
        plugin.accepts.includes(a.kind as "text" | "audio"),
      );

      const result = await plugin.deliver(
        config,
        {
          id: digest.id,
          topicName: topic.name,
          summary: digest.summary ?? "",
          createdAt: digest.createdAt,
          itemCount,
        },
        accepted.map((a) => ({
          kind: a.kind as "text" | "audio",
          mime: a.mime,
          path: a.path ?? undefined,
          text: a.text ?? undefined,
          bytes: a.bytes ?? undefined,
        })),
      );

      await recordDelivery(deps.db, digestId, sink.id, {
        status: "delivered",
        externalRef: result.externalRef ?? null,
        error: null,
        attemptedAt: now(),
      });
      outcomes.push({
        sinkId: sink.id,
        status: "delivered",
        externalRef: result.externalRef,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      await recordDelivery(deps.db, digestId, sink.id, {
        status: "failed",
        externalRef: null,
        error,
        attemptedAt: now(),
      });
      outcomes.push({ sinkId: sink.id, status: "failed", error });
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function makeJobKey(topicId: string, at: Date): string {
  // Deterministic to the minute. Two poll runs inside the same minute for the
  // same topic collide on the unique index rather than creating twin digests.
  const stamp = at.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `${topicId}:${stamp}`;
}

async function recordDelivery(
  db: Database,
  digestId: string,
  sinkId: string,
  values: {
    status: string;
    externalRef: string | null;
    error: string | null;
    attemptedAt: Date;
  },
): Promise<void> {
  await db
    .insert(deliveries)
    .values({ digestId, sinkId, ...values })
    .onConflictDoUpdate({
      target: [deliveries.digestId, deliveries.sinkId],
      set: values,
    });
}

async function selectCandidateItems(db: Database, topicId: string) {
  const sourceRows = await db
    .select({ sourceId: topicSources.sourceId })
    .from(topicSources)
    .where(eq(topicSources.topicId, topicId));

  const sourceIds = sourceRows.map((r) => r.sourceId);
  if (sourceIds.length === 0) return [];

  const alreadyUsed = db
    .select({ itemId: digestItems.itemId })
    .from(digestItems)
    .innerJoin(digests, eq(digests.id, digestItems.digestId))
    .where(eq(digests.topicId, topicId));

  return db
    .select()
    .from(items)
    .where(
      and(
        inArray(items.sourceId, sourceIds),
        notInArray(items.id, alreadyUsed),
      ),
    );
}

async function loadKeywordRules(
  db: Database,
  topicId: string,
): Promise<KeywordRule[]> {
  const rows = await db
    .select()
    .from(keywords)
    .where(eq(keywords.topicId, topicId));
  return rows.map((r) => ({
    term: r.term,
    mode: r.mode === "exclude" ? "exclude" : "include",
  }));
}

async function loadIncludedItems(
  db: Database,
  digestId: string,
): Promise<NormalizedItem[]> {
  const rows = await db
    .select({ item: items })
    .from(digestItems)
    .innerJoin(items, eq(items.id, digestItems.itemId))
    .where(
      and(eq(digestItems.digestId, digestId), eq(digestItems.included, true)),
    );
  return rows.map((r) => toNormalized(r.item));
}

function toNormalized(row: typeof items.$inferSelect): NormalizedItem {
  return {
    externalId: row.externalId,
    url: row.url,
    title: row.title,
    publishedAt: row.publishedAt,
    body: row.body ?? undefined,
    raw: row.raw,
  };
}

async function requireTopic(db: Database, topicId: string): Promise<Topic> {
  const [row] = await db.select().from(topics).where(eq(topics.id, topicId));
  if (!row) throw new Error(`Unknown topic: ${topicId}`);
  return row;
}

async function requireDigest(db: Database, digestId: string) {
  const [row] = await db.select().from(digests).where(eq(digests.id, digestId));
  if (!row) throw new Error(`Unknown digest: ${digestId}`);
  return row;
}
