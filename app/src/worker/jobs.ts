import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  artifacts,
  digests,
  items,
  settings,
  topics,
} from "../db/schema.js";
import type { PluginRegistry } from "../core/registry.js";
import { ingestAll } from "../pipeline/ingest.js";
import {
  approveDigest,
  buildDraft,
  deliverDigest,
  renderDigest,
} from "../pipeline/digest.js";

/**
 * Job bodies, kept free of pg-boss so they can be tested directly against a
 * real database without standing up a queue. `index.ts` is the only file that
 * knows pg-boss exists.
 */

export interface JobDeps {
  db: Database;
  registry: PluginRegistry;
  now?: () => Date;
  /** Injectable so retention tests do not touch the real filesystem. */
  removeFile?: (path: string) => Promise<void>;
  dataDir?: string;
  log?: (event: Record<string, unknown>) => void;
}

function logger(deps: JobDeps) {
  return (
    deps.log ??
    ((event: Record<string, unknown>) =>
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...event })))
  );
}

/** Poll every enabled source. Failures are per-source and never throw. */
export async function pollAllSources(deps: JobDeps) {
  const log = logger(deps);
  const results = await ingestAll(deps);

  const inserted = results.reduce((n, r) => n + r.inserted, 0);
  const failed = results.filter((r) => r.error);
  log({
    job: "poll-all",
    sources: results.length,
    inserted,
    failed: failed.length,
  });
  return { sources: results.length, inserted, failed: failed.length, results };
}

export interface TopicCycleResult {
  topicId: string;
  digestId: string | null;
  /** What the cycle actually did, for the Runs view. */
  outcome:
    | "no-items"
    | "no-matches"
    | "draft-awaiting-curation"
    | "rendered"
    | "render-skipped"
    | "render-failed";
  detail?: string;
}

/**
 * Build a draft for one topic and, when the topic is on auto curation, carry
 * it through render and delivery.
 *
 * A manual topic deliberately stops at the draft: the approval gate exists to
 * keep junk from consuming the quota-limited render step, and auto-advancing
 * here would quietly defeat it.
 */
export async function runTopicCycle(
  deps: JobDeps,
  topicId: string,
): Promise<TopicCycleResult> {
  const log = logger(deps);
  const draft = await buildDraft(deps, topicId);

  if (draft.digestId === null) {
    log({ job: "topic-cycle", topicId, outcome: draft.reason });
    return {
      topicId,
      digestId: null,
      outcome: draft.reason ?? "no-items",
    };
  }

  const [topic] = await deps.db
    .select()
    .from(topics)
    .where(eq(topics.id, topicId));

  if (topic?.curationMode !== "auto") {
    log({
      job: "topic-cycle",
      topicId,
      digestId: draft.digestId,
      outcome: "draft-awaiting-curation",
      matched: draft.matched,
    });
    return {
      topicId,
      digestId: draft.digestId,
      outcome: "draft-awaiting-curation",
    };
  }

  const rendered = await renderDigest(deps, draft.digestId);
  if (rendered.status !== "ready") {
    log({
      job: "topic-cycle",
      topicId,
      digestId: draft.digestId,
      outcome: `render-${rendered.status}`,
      reason: rendered.reason,
    });
    return {
      topicId,
      digestId: draft.digestId,
      outcome: rendered.status === "skipped" ? "render-skipped" : "render-failed",
      detail: rendered.reason,
    };
  }

  const delivered = await deliverDigest(deps, draft.digestId);
  log({
    job: "topic-cycle",
    topicId,
    digestId: draft.digestId,
    outcome: "rendered",
    delivered: delivered.filter((d) => d.status === "delivered").length,
    failedDeliveries: delivered.filter((d) => d.status === "failed").length,
  });

  return { topicId, digestId: draft.digestId, outcome: "rendered" };
}

/** Approve then render then deliver. This is what the UI's Render button drives. */
export async function renderAndDeliver(deps: JobDeps, digestId: string) {
  const log = logger(deps);
  const [digest] = await deps.db
    .select()
    .from(digests)
    .where(eq(digests.id, digestId));
  if (!digest) throw new Error(`Unknown digest: ${digestId}`);

  if (digest.status === "draft") {
    await approveDigest(deps.db, digestId);
  }

  const rendered = await renderDigest(deps, digestId);
  if (rendered.status !== "ready") {
    log({ job: "render-and-deliver", digestId, status: rendered.status, reason: rendered.reason });
    return { rendered, delivered: [] };
  }

  const delivered = await deliverDigest(deps, digestId);
  log({ job: "render-and-deliver", digestId, status: "ready", sinks: delivered.length });
  return { rendered, delivered };
}

export interface RetentionResult {
  artifactsRemoved: number;
  filesDeleted: number;
  itemsRemoved: number;
}

/**
 * Prune old data. Audio is what actually fills the disk, so artifacts and
 * their files go first; digest text is small and is kept with the digest row.
 */
export async function runRetention(deps: JobDeps): Promise<RetentionResult> {
  const log = logger(deps);
  const now = (deps.now ?? (() => new Date()))();

  const [config] = await deps.db.select().from(settings);
  const retentionDays = config?.retentionDays ?? 30;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  const stale = await deps.db
    .select()
    .from(artifacts)
    .where(lt(artifacts.createdAt, cutoff));

  let filesDeleted = 0;
  const remove = deps.removeFile;
  for (const artifact of stale) {
    if (!artifact.path || !remove) continue;
    try {
      await remove(artifact.path);
      filesDeleted += 1;
    } catch (cause) {
      // A missing file is not a failure: the row is the thing we must clear,
      // and re-running retention must not get stuck on an already-deleted mp3.
      log({
        job: "retention",
        warn: "could not delete artifact file",
        path: artifact.path,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (stale.length > 0) {
    await deps.db.delete(artifacts).where(lt(artifacts.createdAt, cutoff));
  }

  const removedItems = await deps.db
    .delete(items)
    .where(lt(items.fetchedAt, cutoff))
    .returning({ id: items.id });

  const result: RetentionResult = {
    artifactsRemoved: stale.length,
    filesDeleted,
    itemsRemoved: removedItems.length,
  };
  log({ job: "retention", retentionDays, ...result });
  return result;
}

/** Topics due for a cycle, with their effective schedule resolved. */
export async function scheduledTopics(db: Database) {
  const [config] = await db.select().from(settings);
  const fallback = config?.defaultSchedule ?? "0 7 * * *";

  const rows = await db
    .select()
    .from(topics)
    .where(eq(topics.enabled, true));

  return rows.map((topic) => ({
    topic,
    schedule: topic.schedule ?? fallback,
  }));
}

/** Ensure the singleton settings row exists. Safe to call repeatedly. */
export async function ensureSettings(db: Database) {
  await db
    .insert(settings)
    .values({ id: "global" })
    .onConflictDoNothing();
  const [row] = await db.select().from(settings);
  return row!;
}

/** Counts for the dashboard. */
export async function dashboardCounts(db: Database) {
  const [topicCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(topics);
  const [itemCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items);
  const [digestCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(digests);

  return {
    topics: topicCount?.n ?? 0,
    items: itemCount?.n ?? 0,
    digests: digestCount?.n ?? 0,
  };
}

/** Digests still waiting on a human. The dashboard nudges about these. */
export async function pendingDrafts(db: Database) {
  return db.select().from(digests).where(eq(digests.status, "draft"));
}
