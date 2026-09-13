import { desc, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../db/client.js";
import {
  artifacts,
  deliveries,
  digestItems,
  digests,
  items,
  keywords,
  sinks,
  sources,
  topicSinks,
  topicSources,
  topics,
} from "../db/schema.js";

/** Read-side queries for the pages. Pure reads; no writes live here. */

async function countRows(db: Database, table: PgTable): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table);
  return rows[0]?.count ?? 0;
}

export interface DashboardStats {
  topics: number;
  sources: number;
  items: number;
  digests: number;
}

export async function dashboardStats(db: Database): Promise<DashboardStats> {
  const [topicCount, sourceCount, itemCount, digestCount] = await Promise.all([
    countRows(db, topics),
    countRows(db, sources),
    countRows(db, items),
    countRows(db, digests),
  ]);
  return {
    topics: topicCount,
    sources: sourceCount,
    items: itemCount,
    digests: digestCount,
  };
}

export interface DigestRow {
  id: string;
  status: string;
  summary: string | null;
  error: string | null;
  createdAt: Date;
  renderedAt: Date | null;
  topicId: string;
  topicName: string;
  itemCount: number;
}

export async function listDigests(
  db: Database,
  limit = 100,
): Promise<DigestRow[]> {
  const rows = await db
    .select({
      id: digests.id,
      status: digests.status,
      summary: digests.summary,
      error: digests.error,
      createdAt: digests.createdAt,
      renderedAt: digests.renderedAt,
      topicId: topics.id,
      topicName: topics.name,
      itemCount: sql<number>`(
        select count(*)::int from ${digestItems}
        where ${digestItems.digestId} = ${digests.id}
          and ${digestItems.included} = true
      )`,
    })
    .from(digests)
    .innerJoin(topics, eq(topics.id, digests.topicId))
    .orderBy(desc(digests.createdAt))
    .limit(limit);
  return rows;
}

export interface SourceRun {
  id: string;
  label: string;
  pluginId: string;
  enabled: boolean;
  lastPolledAt: Date | null;
  lastError: string | null;
  itemCount: number;
  /**
   * The stored plugin config: the feed URL, the search query, the channel id.
   * Carried so the page can show what a source actually asks for and prefill
   * the edit form. Secrets are masked at render time, not here - the edit form
   * needs the real values to round-trip an unchanged field.
   */
  config: unknown;
}

/**
 * The "why did nothing show up this morning" view: last poll time and last
 * error per source, so a silent feed is one click from being explained.
 */
export async function listSourceRuns(db: Database): Promise<SourceRun[]> {
  // A LEFT JOIN + GROUP BY rather than a correlated subquery, deliberately.
  //
  // The subquery version silently returned 0 for every source: Drizzle renders
  // an interpolated column inside sql`` WITHOUT its table qualifier, so
  //     (select count(*) from items where source_id = id)
  // resolved both bare names against the inner table and compared
  // items.source_id to items.id. Valid SQL, never true, no error anywhere.
  // Join conditions are qualified properly, so the scoping bug cannot recur.
  //
  // GROUP BY on the primary key is enough for Postgres to allow the other
  // source columns in the select list.
  return db
    .select({
      id: sources.id,
      label: sources.label,
      pluginId: sources.pluginId,
      enabled: sources.enabled,
      lastPolledAt: sources.lastPolledAt,
      lastError: sources.lastError,
      config: sources.config,
      itemCount: sql<number>`count(${items.id})::int`,
    })
    .from(sources)
    .leftJoin(items, eq(items.sourceId, sources.id))
    .groupBy(sources.id)
    .orderBy(sources.label);
}

export async function listTopics(db: Database) {
  return db
    .select({
      id: topics.id,
      name: topics.name,
      slug: topics.slug,
      description: topics.description,
      enabled: topics.enabled,
      schedule: topics.schedule,
      curationMode: topics.curationMode,
      rendererId: topics.rendererId,
      sourceCount: sql<number>`(
        select count(*)::int from ${topicSources}
        where ${topicSources.topicId} = ${topics.id}
      )`,
      digestCount: sql<number>`(
        select count(*)::int from ${digests}
        where ${digests.topicId} = ${topics.id}
      )`,
    })
    .from(topics)
    .orderBy(topics.name);
}

export async function getTopic(db: Database, topicId: string) {
  const [row] = await db.select().from(topics).where(eq(topics.id, topicId));
  return row ?? null;
}

export async function listTopicSourceIds(
  db: Database,
  topicId: string,
): Promise<string[]> {
  const rows = await db
    .select({ sourceId: topicSources.sourceId })
    .from(topicSources)
    .where(eq(topicSources.topicId, topicId));
  return rows.map((r) => r.sourceId);
}

export async function listTopicSinkIds(
  db: Database,
  topicId: string,
): Promise<string[]> {
  const rows = await db
    .select({ sinkId: topicSinks.sinkId })
    .from(topicSinks)
    .where(eq(topicSinks.topicId, topicId));
  return rows.map((r) => r.sinkId);
}

export async function listKeywords(db: Database, topicId: string) {
  return db
    .select()
    .from(keywords)
    .where(eq(keywords.topicId, topicId))
    .orderBy(keywords.term);
}

export async function listSources(db: Database): Promise<SourceRun[]> {
  return listSourceRuns(db);
}

export async function listSinks(db: Database) {
  return db.select().from(sinks).orderBy(sinks.label);
}

export async function getSource(db: Database, sourceId: string) {
  const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
  return row ?? null;
}

export interface DigestDetail {
  digest: typeof digests.$inferSelect;
  topicName: string;
  items: Array<{
    id: string;
    title: string;
    url: string;
    publishedAt: Date;
    body: string | null;
    included: boolean;
    sourceLabel: string;
  }>;
  artifacts: Array<typeof artifacts.$inferSelect>;
  deliveries: Array<{
    id: string;
    status: string;
    externalRef: string | null;
    error: string | null;
    attemptedAt: Date | null;
    sinkLabel: string;
  }>;
}

export async function getDigestDetail(
  db: Database,
  digestId: string,
): Promise<DigestDetail | null> {
  const [digest] = await db
    .select()
    .from(digests)
    .where(eq(digests.id, digestId));
  if (!digest) return null;

  const [topic] = await db
    .select({ name: topics.name })
    .from(topics)
    .where(eq(topics.id, digest.topicId));

  const itemRows = await db
    .select({
      id: items.id,
      title: items.title,
      url: items.url,
      publishedAt: items.publishedAt,
      body: items.body,
      included: digestItems.included,
      sourceLabel: sources.label,
    })
    .from(digestItems)
    .innerJoin(items, eq(items.id, digestItems.itemId))
    .innerJoin(sources, eq(sources.id, items.sourceId))
    .where(eq(digestItems.digestId, digestId))
    .orderBy(desc(items.publishedAt));

  const artifactRows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.digestId, digestId));

  const deliveryRows = await db
    .select({
      id: deliveries.id,
      status: deliveries.status,
      externalRef: deliveries.externalRef,
      error: deliveries.error,
      attemptedAt: deliveries.attemptedAt,
      sinkLabel: sinks.label,
    })
    .from(deliveries)
    .innerJoin(sinks, eq(sinks.id, deliveries.sinkId))
    .where(eq(deliveries.digestId, digestId));

  return {
    digest,
    topicName: topic?.name ?? "(deleted topic)",
    items: itemRows,
    artifacts: artifactRows,
    deliveries: deliveryRows,
  };
}
