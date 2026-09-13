import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./testing.js";
import {
  digestItems,
  digests,
  items,
  keywords,
  renderLog,
  sources,
  topicSources,
  topics,
} from "./schema.js";

/**
 * These run against real Postgres (pglite, in-process). The point is to prove
 * the CONSTRAINTS behave, not that the ORM can round-trip a row: the dedup
 * guarantee and the cascade rules are the parts that would silently corrupt
 * data if they were wrong.
 */
describe("schema", () => {
  let h: TestDb;

  beforeEach(async () => {
    h = await createTestDb();
  });

  afterEach(async () => {
    await h.close();
  });

  async function makeTopic(name = "AI News") {
    const [row] = await h.db
      .insert(topics)
      .values({ name, slug: name.toLowerCase().replace(/\s+/g, "-") })
      .returning();
    return row!;
  }

  async function makeSource(label = "Feed") {
    const [row] = await h.db
      .insert(sources)
      .values({ pluginId: "rss", label, config: { url: "https://e.com/f" } })
      .returning();
    return row!;
  }

  it("applies all migrations and creates the expected tables", async () => {
    const res = await h.client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    const names = res.rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "artifacts",
        "deliveries",
        "digest_items",
        "digests",
        "items",
        "keywords",
        "plugin_settings",
        "render_log",
        "settings",
        "sinks",
        "sources",
        "topic_sinks",
        "topic_sources",
        "topics",
      ]),
    );
  });

  it("enforces the dedup key: same source + externalId cannot repeat", async () => {
    const source = await makeSource();
    const base = {
      sourceId: source.id,
      externalId: "video-123",
      url: "https://e.com/1",
      title: "First",
      publishedAt: new Date(),
    };

    await h.db.insert(items).values(base);

    // The whole ingest path relies on this constraint existing.
    await expect(
      h.db.insert(items).values({ ...base, title: "Duplicate" }),
    ).rejects.toThrow();
  });

  it("allows the same externalId across different sources", async () => {
    const a = await makeSource("A");
    const b = await makeSource("B");
    const base = {
      externalId: "same-id",
      url: "https://e.com/1",
      title: "T",
      publishedAt: new Date(),
    };

    await h.db.insert(items).values({ ...base, sourceId: a.id });
    await h.db.insert(items).values({ ...base, sourceId: b.id });

    const all = await h.db.select().from(items);
    expect(all).toHaveLength(2);
  });

  it("makes ON CONFLICT DO NOTHING a usable idempotent insert", async () => {
    const source = await makeSource();
    const row = {
      sourceId: source.id,
      externalId: "x",
      url: "https://e.com/x",
      title: "X",
      publishedAt: new Date(),
    };

    await h.db.insert(items).values(row).onConflictDoNothing();
    await h.db.insert(items).values(row).onConflictDoNothing();

    const all = await h.db.select().from(items);
    expect(all).toHaveLength(1);
  });

  it("enforces unique digest jobKey so a retry cannot double-render", async () => {
    const topic = await makeTopic();
    const digest = {
      topicId: topic.id,
      jobKey: "topic-1-2026-01-01",
      rendererId: "llm-text",
    };

    await h.db.insert(digests).values(digest);
    await expect(h.db.insert(digests).values(digest)).rejects.toThrow();
  });

  it("enforces a unique topic slug", async () => {
    await makeTopic("AI News");
    await expect(makeTopic("AI News")).rejects.toThrow();
  });

  it("cascades topic deletion to keywords, links and digests", async () => {
    const topic = await makeTopic();
    const source = await makeSource();

    await h.db
      .insert(topicSources)
      .values({ topicId: topic.id, sourceId: source.id });
    await h.db
      .insert(keywords)
      .values({ topicId: topic.id, term: "ai", mode: "include" });
    await h.db
      .insert(digests)
      .values({ topicId: topic.id, jobKey: "k1", rendererId: "llm-text" });

    await h.db.delete(topics).where(eq(topics.id, topic.id));

    expect(await h.db.select().from(keywords)).toHaveLength(0);
    expect(await h.db.select().from(topicSources)).toHaveLength(0);
    expect(await h.db.select().from(digests)).toHaveLength(0);
  });

  it("cascades source deletion to its items", async () => {
    const source = await makeSource();
    await h.db.insert(items).values({
      sourceId: source.id,
      externalId: "a",
      url: "https://e.com/a",
      title: "A",
      publishedAt: new Date(),
    });

    await h.db.delete(sources).where(eq(sources.id, source.id));
    expect(await h.db.select().from(items)).toHaveLength(0);
  });

  it("keeps render_log rows when the digest is deleted", async () => {
    // render_log is the quota record. Losing rows when a digest is cleaned up
    // would under-count usage and let us exceed the upstream budget.
    const topic = await makeTopic();
    const [digest] = await h.db
      .insert(digests)
      .values({ topicId: topic.id, jobKey: "k", rendererId: "notebooklm" })
      .returning();

    await h.db
      .insert(renderLog)
      .values({ rendererId: "notebooklm", digestId: digest!.id });

    await h.db.delete(digests).where(eq(digests.id, digest!.id));

    const log = await h.db.select().from(renderLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.digestId).toBeNull();
  });

  it("defaults a digest to draft status and curation to manual", async () => {
    const topic = await makeTopic();
    const [digest] = await h.db
      .insert(digests)
      .values({ topicId: topic.id, jobKey: "k", rendererId: "llm-text" })
      .returning();

    expect(digest!.status).toBe("draft");
    expect(topic.curationMode).toBe("manual");
  });

  it("defaults digest_items.included to true", async () => {
    const topic = await makeTopic();
    const source = await makeSource();
    const [digest] = await h.db
      .insert(digests)
      .values({ topicId: topic.id, jobKey: "k", rendererId: "llm-text" })
      .returning();
    const [item] = await h.db
      .insert(items)
      .values({
        sourceId: source.id,
        externalId: "a",
        url: "https://e.com/a",
        title: "A",
        publishedAt: new Date(),
      })
      .returning();

    await h.db
      .insert(digestItems)
      .values({ digestId: digest!.id, itemId: item!.id });

    const [link] = await h.db.select().from(digestItems);
    expect(link!.included).toBe(true);
  });
});
