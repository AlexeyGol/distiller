import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A Topic groups sources and owns the keyword rules. It is the unit a digest
 * is generated for: one topic == one podcast feed ("AI news", "Kubernetes").
 */
export const topics = pgTable("topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Steers the renderer prompt / notebook framing. */
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  /** Cron expression. Null falls back to settings.default_schedule. */
  schedule: text("schedule"),
  /** "auto" renders immediately; "manual" waits for curation. */
  curationMode: text("curation_mode").notNull().default("manual"),
  rendererId: text("renderer_id").notNull().default("llm-text"),
  rendererConfig: jsonb("renderer_config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A configured instance of a source plugin (one feed, one channel, one query). */
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  pluginId: text("plugin_id").notNull(),
  label: text("label").notNull(),
  config: jsonb("config").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  cursor: jsonb("cursor"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Many-to-many: one source can feed several topics. */
export const topicSources = pgTable(
  "topic_sources",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.topicId, t.sourceId] })],
);

/** Keyword rules are per-topic: the same feed can match differently per topic. */
export const keywords = pgTable(
  "keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    /** "include" | "exclude" */
    mode: text("mode").notNull().default("include"),
  },
  (t) => [index("keywords_topic_idx").on(t.topicId)],
);

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    body: text("body"),
    raw: jsonb("raw"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The dedup key. Re-polling a feed must never duplicate an item.
    unique("items_source_external_uq").on(t.sourceId, t.externalId),
    index("items_published_idx").on(t.publishedAt),
  ],
);

/**
 * A digest moves DRAFT -> APPROVED -> RENDERING -> READY (or FAILED).
 * The approval gate is what stops junk from consuming the render quota.
 */
export const digests = pgTable(
  "digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    /** Idempotency key: a retry resumes rather than re-rendering. */
    jobKey: text("job_key").notNull().unique(),
    rendererId: text("renderer_id").notNull(),
    /** draft | approved | rendering | ready | failed */
    status: text("status").notNull().default("draft"),
    summary: text("summary"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
  },
  (t) => [index("digests_topic_status_idx").on(t.topicId, t.status)],
);

/** Curation lives here: `included` is what the user ticks before rendering. */
export const digestItems = pgTable(
  "digest_items",
  {
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    included: boolean("included").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.digestId, t.itemId] })],
);

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  digestId: uuid("digest_id")
    .notNull()
    .references(() => digests.id, { onDelete: "cascade" }),
  /** "text" | "audio" */
  kind: text("kind").notNull(),
  mime: text("mime").notNull(),
  /** Relative to the data volume. Null for inline text artifacts. */
  path: text("path"),
  text: text("text"),
  bytes: integer("bytes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sinks = pgTable("sinks", {
  id: uuid("id").primaryKey().defaultRandom(),
  pluginId: text("plugin_id").notNull(),
  label: text("label").notNull(),
  config: jsonb("config").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

export const topicSinks = pgTable(
  "topic_sinks",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    sinkId: uuid("sink_id")
      .notNull()
      .references(() => sinks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.topicId, t.sinkId] })],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    sinkId: uuid("sink_id")
      .notNull()
      .references(() => sinks.id, { onDelete: "cascade" }),
    /** pending | delivered | failed */
    status: text("status").notNull().default("pending"),
    externalRef: text("external_ref"),
    error: text("error"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  },
  (t) => [unique("deliveries_digest_sink_uq").on(t.digestId, t.sinkId)],
);

/**
 * One row per render attempt. A timestamped event log, NOT a date-keyed
 * counter: the upstream quota window is uncertain (rolling 24h vs a weekly
 * compute budget) and may change, and a log answers any window question with
 * a different WHERE clause.
 */
export const renderLog = pgTable(
  "render_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rendererId: text("renderer_id").notNull(),
    digestId: uuid("digest_id").references(() => digests.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("render_log_renderer_created_idx").on(t.rendererId, t.createdAt)],
);

/** Type-level plugin toggle: hides from the catalog and pauses all instances. */
export const pluginSettings = pgTable(
  "plugin_settings",
  {
    pluginId: text("plugin_id").notNull(),
    /** "source" | "renderer" | "sink" */
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.kind] })],
);

/** Singleton row (id is always "global"). */
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("global"),
  defaultSchedule: text("default_schedule").notNull().default("0 7 * * *"),
  defaultCurationMode: text("default_curation_mode").notNull().default("manual"),
  retentionDays: integer("retention_days").notNull().default(30),
});

export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Digest = typeof digests.$inferSelect;
export type NewDigest = typeof digests.$inferInsert;
export type Keyword = typeof keywords.$inferSelect;
export type Sink = typeof sinks.$inferSelect;
