import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, type TestDb } from "../db/testing.js";
import {
  artifacts,
  deliveries,
  digestItems,
  digests,
  items,
  keywords,
  renderLog,
  sinks,
  sources,
  topicSinks,
  topicSources,
  topics,
} from "../db/schema.js";
import { PluginRegistry } from "../core/registry.js";
import {
  QuotaExhaustedError,
  type NormalizedItem,
  type RendererPlugin,
  type SinkPlugin,
  type SourcePlugin,
} from "../core/types.js";
import { ingestAll, ingestSource, insertNewItems } from "./ingest.js";
import {
  approveDigest,
  buildDraft,
  deliverDigest,
  makeJobKey,
  renderDigest,
  rendersInWindow,
  setItemIncluded,
} from "./digest.js";

// ---------------------------------------------------------------------------
// test doubles
// ---------------------------------------------------------------------------

function fakeItem(n: number, over: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: `ext-${n}`,
    url: `https://example.com/${n}`,
    title: `Item ${n}`,
    publishedAt: new Date(`2026-01-0${n}T00:00:00Z`),
    raw: { n },
    ...over,
  };
}

/** A source plugin whose behaviour each test controls. */
function fakeSource(
  impl: Partial<SourcePlugin<{ url: string }>> = {},
): SourcePlugin<{ url: string }> {
  return {
    kind: "source",
    id: "fake",
    label: "Fake",
    description: "test double",
    configSchema: z.object({ url: z.string().url() }),
    capabilities: { pollable: true, supportsCursor: true },
    fetch: async () => ({ items: [], cursor: null }),
    ...impl,
  } as SourcePlugin<{ url: string }>;
}

function fakeRenderer(
  impl: Partial<RendererPlugin<Record<string, never>>> = {},
): RendererPlugin<Record<string, never>> {
  return {
    kind: "renderer",
    id: "fake-renderer",
    label: "Fake renderer",
    description: "test double",
    configSchema: z.object({}).passthrough(),
    produces: { text: true, audio: false },
    render: async (_c, input) => ({
      summary: `summary of ${input.items.length}`,
      artifacts: [
        { kind: "text", mime: "text/plain", text: "the text" },
      ],
    }),
    ...impl,
  } as RendererPlugin<Record<string, never>>;
}

function fakeSink(
  impl: Partial<SinkPlugin<Record<string, never>>> = {},
): SinkPlugin<Record<string, never>> {
  return {
    kind: "sink",
    id: "fake-sink",
    label: "Fake sink",
    description: "test double",
    configSchema: z.object({}).passthrough(),
    accepts: ["text", "audio"],
    deliver: async () => ({ externalRef: "msg-1" }),
    ...impl,
  } as SinkPlugin<Record<string, never>>;
}

// ---------------------------------------------------------------------------

describe("pipeline", () => {
  let h: TestDb;

  beforeEach(async () => {
    h = await createTestDb();
  });

  afterEach(async () => {
    await h.close();
  });

  async function seedSource(pluginId = "fake") {
    const [row] = await h.db
      .insert(sources)
      .values({
        pluginId,
        label: "Feed",
        config: { url: "https://example.com/feed" },
      })
      .returning();
    return row!;
  }

  async function seedTopic(over: Partial<typeof topics.$inferInsert> = {}) {
    const [row] = await h.db
      .insert(topics)
      .values({
        name: "AI News",
        slug: `ai-news-${Math.random().toString(36).slice(2, 8)}`,
        rendererId: "fake-renderer",
        ...over,
      })
      .returning();
    return row!;
  }

  // -------------------------------------------------------------------------
  describe("ingestSource", () => {
    it("inserts fetched items and records the cursor", async () => {
      const source = await seedSource();
      const registry = new PluginRegistry().registerSource(
        fakeSource({
          fetch: async () => ({
            items: [fakeItem(1), fakeItem(2)],
            cursor: { etag: "W/abc" },
          }),
        }),
      );

      const result = await ingestSource({ db: h.db, registry }, source);

      expect(result).toMatchObject({ fetched: 2, inserted: 2 });
      expect(await h.db.select().from(items)).toHaveLength(2);

      const [after] = await h.db
        .select()
        .from(sources)
        .where(eq(sources.id, source.id));
      expect(after!.cursor).toEqual({ etag: "W/abc" });
      expect(after!.lastPolledAt).toBeInstanceOf(Date);
      expect(after!.lastError).toBeNull();
    });

    it("hands the stored cursor back to the plugin on the next poll", async () => {
      const source = await seedSource();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce({ items: [fakeItem(1)], cursor: { etag: "v1" } })
        .mockResolvedValueOnce({ items: [], cursor: { etag: "v1" } });

      const registry = new PluginRegistry().registerSource(fakeSource({ fetch }));
      const deps = { db: h.db, registry };

      await ingestSource(deps, source);
      const [reloaded] = await h.db
        .select()
        .from(sources)
        .where(eq(sources.id, source.id));
      await ingestSource(deps, reloaded!);

      expect(fetch.mock.calls[0]![1]).toBeNull();
      expect(fetch.mock.calls[1]![1]).toEqual({ etag: "v1" });
    });

    it("does not duplicate items already stored (re-poll is a no-op)", async () => {
      const source = await seedSource();
      const registry = new PluginRegistry().registerSource(
        fakeSource({
          fetch: async () => ({ items: [fakeItem(1), fakeItem(2)], cursor: null }),
        }),
      );
      const deps = { db: h.db, registry };

      const first = await ingestSource(deps, source);
      const second = await ingestSource(deps, source);

      expect(first.inserted).toBe(2);
      expect(second.fetched).toBe(2);
      expect(second.inserted).toBe(0);
      expect(await h.db.select().from(items)).toHaveLength(2);
    });

    it("records the error instead of throwing when a fetch fails", async () => {
      const source = await seedSource();
      const registry = new PluginRegistry().registerSource(
        fakeSource({
          fetch: async () => {
            throw new Error("feed is down");
          },
        }),
      );

      const result = await ingestSource({ db: h.db, registry }, source);

      expect(result.error).toBe("feed is down");
      expect(result.inserted).toBe(0);
      const [after] = await h.db
        .select()
        .from(sources)
        .where(eq(sources.id, source.id));
      expect(after!.lastError).toBe("feed is down");
    });

    it("reports an unknown plugin id rather than skipping silently", async () => {
      const source = await seedSource("no-such-plugin");
      const registry = new PluginRegistry();

      const result = await ingestSource({ db: h.db, registry }, source);

      expect(result.error).toContain("Unknown source plugin");
    });

    it("rejects a source whose stored config no longer validates", async () => {
      const [source] = await h.db
        .insert(sources)
        .values({ pluginId: "fake", label: "Bad", config: { url: "not-a-url" } })
        .returning();
      const registry = new PluginRegistry().registerSource(fakeSource());

      const result = await ingestSource({ db: h.db, registry }, source!);

      expect(result.error).toContain("Invalid config");
    });

    it("isolates a failing source from the rest of the run", async () => {
      await h.db
        .insert(sources)
        .values({ pluginId: "good", label: "G", config: { url: "https://a.com" } });
      await h.db
        .insert(sources)
        .values({ pluginId: "bad", label: "B", config: { url: "https://b.com" } });

      const registry = new PluginRegistry()
        .registerSource(
          fakeSource({
            id: "good",
            fetch: async () => ({ items: [fakeItem(1)], cursor: null }),
          }),
        )
        .registerSource(
          fakeSource({
            id: "bad",
            fetch: async () => {
              throw new Error("boom");
            },
          }),
        );

      const results = await ingestAll({ db: h.db, registry });

      expect(results).toHaveLength(2);
      expect(results.filter((r) => r.error)).toHaveLength(1);
      expect(await h.db.select().from(items)).toHaveLength(1);
    });

    it("skips disabled sources", async () => {
      await h.db.insert(sources).values({
        pluginId: "fake",
        label: "Off",
        config: { url: "https://a.com" },
        enabled: false,
      });
      const registry = new PluginRegistry().registerSource(fakeSource());

      expect(await ingestAll({ db: h.db, registry })).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("insertNewItems", () => {
    it("collapses duplicate externalIds inside a single batch", async () => {
      // Badly generated feeds really do repeat a guid within one page; a
      // multi-row insert would otherwise self-conflict and abort.
      const source = await seedSource();
      const n = await insertNewItems(h.db, source.id, [
        fakeItem(1),
        fakeItem(1, { title: "Repeat" }),
      ]);
      expect(n).toBe(1);
    });

    it("returns 0 for an empty batch without touching the database", async () => {
      const source = await seedSource();
      expect(await insertNewItems(h.db, source.id, [])).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("buildDraft", () => {
    async function seedTopicWithItems(
      keywordRules: { term: string; mode: string }[] = [],
      itemTitles = ["AI breakthrough", "Gardening tips"],
    ) {
      const topic = await seedTopic();
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });

      await h.db.insert(items).values(
        itemTitles.map((title, i) => ({
          sourceId: source.id,
          externalId: `e-${i}`,
          url: `https://example.com/${i}`,
          title,
          publishedAt: new Date("2026-01-01T00:00:00Z"),
        })),
      );

      if (keywordRules.length > 0) {
        await h.db
          .insert(keywords)
          .values(keywordRules.map((k) => ({ topicId: topic.id, ...k })));
      }
      return topic;
    }

    it("creates a draft containing only items matching the topic keywords", async () => {
      const topic = await seedTopicWithItems([{ term: "AI", mode: "include" }]);
      const registry = new PluginRegistry();

      const result = await buildDraft({ db: h.db, registry }, topic.id);

      expect(result.candidates).toBe(2);
      expect(result.matched).toBe(1);

      const links = await h.db
        .select()
        .from(digestItems)
        .where(eq(digestItems.digestId, result.digestId!));
      expect(links).toHaveLength(1);
    });

    it("includes everything when the topic has no keyword rules", async () => {
      const topic = await seedTopicWithItems([]);
      const result = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      );
      expect(result.matched).toBe(2);
    });

    it("starts as draft when curation is manual", async () => {
      const topic = await seedTopicWithItems([]);
      const result = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      );
      const [digest] = await h.db
        .select()
        .from(digests)
        .where(eq(digests.id, result.digestId!));
      expect(digest!.status).toBe("draft");
    });

    it("starts as approved when curation is auto", async () => {
      const topic = await seedTopic({ curationMode: "auto" });
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db.insert(items).values({
        sourceId: source.id,
        externalId: "e",
        url: "https://e.com/1",
        title: "T",
        publishedAt: new Date(),
      });

      const result = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      );
      const [digest] = await h.db
        .select()
        .from(digests)
        .where(eq(digests.id, result.digestId!));
      expect(digest!.status).toBe("approved");
    });

    it("does not put the same item into two digests of one topic", async () => {
      const topic = await seedTopicWithItems([]);
      const deps = { db: h.db, registry: new PluginRegistry() };

      const first = await buildDraft(deps, topic.id);
      const second = await buildDraft(deps, topic.id);

      expect(first.matched).toBe(2);
      expect(second.digestId).toBeNull();
      expect(second.reason).toBe("no-items");
    });

    it("lets two topics each include the same item", async () => {
      const source = await seedSource();
      await h.db.insert(items).values({
        sourceId: source.id,
        externalId: "shared",
        url: "https://e.com/s",
        title: "Shared story",
        publishedAt: new Date(),
      });

      const a = await seedTopic({ name: "A", slug: "a" });
      const b = await seedTopic({ name: "B", slug: "b" });
      await h.db.insert(topicSources).values([
        { topicId: a.id, sourceId: source.id },
        { topicId: b.id, sourceId: source.id },
      ]);

      const deps = { db: h.db, registry: new PluginRegistry() };
      expect((await buildDraft(deps, a.id)).matched).toBe(1);
      expect((await buildDraft(deps, b.id)).matched).toBe(1);
    });

    it("reports no-matches without consuming the items", async () => {
      // Items must stay unattached so that editing the keywords later can
      // still pick them up.
      const topic = await seedTopicWithItems([
        { term: "quantum", mode: "include" },
      ]);
      const deps = { db: h.db, registry: new PluginRegistry() };

      const first = await buildDraft(deps, topic.id);
      expect(first.reason).toBe("no-matches");

      await h.db
        .insert(keywords)
        .values({ topicId: topic.id, term: "AI", mode: "include" });
      const second = await buildDraft(deps, topic.id);
      expect(second.matched).toBe(1);
    });

    it("returns no-items for a topic with no sources", async () => {
      const topic = await seedTopic();
      const result = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      );
      expect(result.reason).toBe("no-items");
    });

    it("throws for an unknown topic", async () => {
      await expect(
        buildDraft(
          { db: h.db, registry: new PluginRegistry() },
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toThrow(/Unknown topic/);
    });
  });

  // -------------------------------------------------------------------------
  describe("makeJobKey", () => {
    it("is stable to the minute for the same topic", () => {
      const a = makeJobKey("t1", new Date("2026-01-01T10:30:15Z"));
      const b = makeJobKey("t1", new Date("2026-01-01T10:30:59Z"));
      expect(a).toBe(b);
    });

    it("differs across minutes and across topics", () => {
      expect(makeJobKey("t1", new Date("2026-01-01T10:30:00Z"))).not.toBe(
        makeJobKey("t1", new Date("2026-01-01T10:31:00Z")),
      );
      expect(makeJobKey("t1", new Date("2026-01-01T10:30:00Z"))).not.toBe(
        makeJobKey("t2", new Date("2026-01-01T10:30:00Z")),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("curation gate", () => {
    async function draftWithTwoItems() {
      const topic = await seedTopic();
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db.insert(items).values([
        {
          sourceId: source.id,
          externalId: "a",
          url: "https://e.com/a",
          title: "A",
          publishedAt: new Date(),
        },
        {
          sourceId: source.id,
          externalId: "b",
          url: "https://e.com/b",
          title: "B",
          publishedAt: new Date(),
        },
      ]);
      const result = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      );
      return { topic, digestId: result.digestId! };
    }

    it("approves a draft that has included items", async () => {
      const { digestId } = await draftWithTwoItems();
      await approveDigest(h.db, digestId);
      const [d] = await h.db.select().from(digests).where(eq(digests.id, digestId));
      expect(d!.status).toBe("approved");
    });

    it("refuses to approve when every item was excluded", async () => {
      const { digestId } = await draftWithTwoItems();
      const links = await h.db
        .select()
        .from(digestItems)
        .where(eq(digestItems.digestId, digestId));
      for (const link of links) {
        await setItemIncluded(h.db, digestId, link.itemId, false);
      }

      await expect(approveDigest(h.db, digestId)).rejects.toThrow(
        /no included items/,
      );
    });

    it("refuses to approve a digest that is not a draft", async () => {
      const { digestId } = await draftWithTwoItems();
      await approveDigest(h.db, digestId);
      await expect(approveDigest(h.db, digestId)).rejects.toThrow(
        /Cannot approve digest in status/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("renderDigest", () => {
    async function approvedDigest(rendererId = "fake-renderer") {
      const topic = await seedTopic({ rendererId, curationMode: "auto" });
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db.insert(items).values({
        sourceId: source.id,
        externalId: "a",
        url: "https://e.com/a",
        title: "A",
        publishedAt: new Date(),
      });
      const result = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      );
      return { topic, digestId: result.digestId! };
    }

    it("renders, stores artifacts and marks the digest ready", async () => {
      const { digestId } = await approvedDigest();
      const registry = new PluginRegistry().registerRenderer(fakeRenderer());

      const result = await renderDigest({ db: h.db, registry }, digestId);

      expect(result.status).toBe("ready");
      const [d] = await h.db.select().from(digests).where(eq(digests.id, digestId));
      expect(d!.status).toBe("ready");
      expect(d!.summary).toBe("summary of 1");
      expect(d!.renderedAt).toBeInstanceOf(Date);
      expect(await h.db.select().from(artifacts)).toHaveLength(1);
    });

    it("logs a successful render for quota accounting", async () => {
      const { digestId } = await approvedDigest();
      const registry = new PluginRegistry().registerRenderer(fakeRenderer());

      await renderDigest({ db: h.db, registry }, digestId);

      expect(await h.db.select().from(renderLog)).toHaveLength(1);
    });

    it("does NOT log a failed render (no upstream quota was consumed)", async () => {
      const { digestId } = await approvedDigest();
      const registry = new PluginRegistry().registerRenderer(
        fakeRenderer({
          render: async () => {
            throw new Error("renderer exploded");
          },
        }),
      );

      const result = await renderDigest({ db: h.db, registry }, digestId);

      expect(result.status).toBe("failed");
      expect(await h.db.select().from(renderLog)).toHaveLength(0);
      const [d] = await h.db.select().from(digests).where(eq(digests.id, digestId));
      expect(d!.status).toBe("failed");
      expect(d!.error).toBe("renderer exploded");
    });

    it("treats an upstream quota error as authoritative", async () => {
      const { digestId } = await approvedDigest();
      const registry = new PluginRegistry().registerRenderer(
        fakeRenderer({
          render: async () => {
            throw new QuotaExhaustedError("daily cap hit");
          },
        }),
      );

      const result = await renderDigest({ db: h.db, registry }, digestId);

      expect(result.status).toBe("failed");
      expect(result.reason).toContain("quota exhausted upstream");
    });

    it("skips when the local safety valve is already at its limit", async () => {
      const { digestId } = await approvedDigest();
      const registry = new PluginRegistry().registerRenderer(
        fakeRenderer({ dailyBudget: 2 }),
      );

      await h.db.insert(renderLog).values([
        { rendererId: "fake-renderer" },
        { rendererId: "fake-renderer" },
      ]);

      const result = await renderDigest({ db: h.db, registry }, digestId);

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("local budget reached");
    });

    it("ignores budget rows outside the window", async () => {
      const { digestId } = await approvedDigest();
      const registry = new PluginRegistry().registerRenderer(
        fakeRenderer({ dailyBudget: 1 }),
      );

      await h.db.insert(renderLog).values({
        rendererId: "fake-renderer",
        createdAt: new Date(Date.now() - 48 * 3600_000),
      });

      const result = await renderDigest({ db: h.db, registry }, digestId);
      expect(result.status).toBe("ready");
    });

    it("refuses to render a digest that is not approved", async () => {
      const topic = await seedTopic({ curationMode: "manual" });
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db.insert(items).values({
        sourceId: source.id,
        externalId: "a",
        url: "https://e.com/a",
        title: "A",
        publishedAt: new Date(),
      });
      const { digestId } = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      ).then((r) => ({ digestId: r.digestId! }));

      const registry = new PluginRegistry().registerRenderer(fakeRenderer());
      const result = await renderDigest({ db: h.db, registry }, digestId);

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain('status is "draft"');
    });

    it("passes only included items to the renderer", async () => {
      const topic = await seedTopic({ curationMode: "auto" });
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db.insert(items).values([
        {
          sourceId: source.id,
          externalId: "a",
          url: "https://e.com/a",
          title: "Keep",
          publishedAt: new Date(),
        },
        {
          sourceId: source.id,
          externalId: "b",
          url: "https://e.com/b",
          title: "Drop",
          publishedAt: new Date(),
        },
      ]);
      const { digestId } = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      ).then((r) => ({ digestId: r.digestId! }));

      const [dropped] = await h.db
        .select()
        .from(items)
        .where(eq(items.title, "Drop"));
      await setItemIncluded(h.db, digestId, dropped!.id, false);

      const render = vi.fn().mockResolvedValue({ summary: "s", artifacts: [] });
      const registry = new PluginRegistry().registerRenderer(
        fakeRenderer({ render }),
      );

      await renderDigest({ db: h.db, registry }, digestId);

      const passed = render.mock.calls[0]![1].items as NormalizedItem[];
      expect(passed.map((i) => i.title)).toEqual(["Keep"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("rendersInWindow", () => {
    it("counts only rows inside the window for that renderer", async () => {
      const now = new Date("2026-01-02T00:00:00Z");
      await h.db.insert(renderLog).values([
        { rendererId: "r1", createdAt: new Date("2026-01-01T23:00:00Z") },
        { rendererId: "r1", createdAt: new Date("2025-12-30T00:00:00Z") },
        { rendererId: "r2", createdAt: new Date("2026-01-01T23:00:00Z") },
      ]);

      expect(await rendersInWindow(h.db, "r1", 24, now)).toBe(1);
      expect(await rendersInWindow(h.db, "r1", 24 * 10, now)).toBe(2);
      expect(await rendersInWindow(h.db, "missing", 24, now)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("deliverDigest", () => {
    async function readyDigest() {
      const topic = await seedTopic({ curationMode: "auto" });
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db.insert(items).values({
        sourceId: source.id,
        externalId: "a",
        url: "https://e.com/a",
        title: "A",
        publishedAt: new Date(),
      });
      const { digestId } = await buildDraft(
        { db: h.db, registry: new PluginRegistry() },
        topic.id,
      ).then((r) => ({ digestId: r.digestId! }));

      const registry = new PluginRegistry().registerRenderer(fakeRenderer());
      await renderDigest({ db: h.db, registry }, digestId);
      return { topic, digestId };
    }

    async function attachSink(topicId: string, pluginId = "fake-sink") {
      const [sink] = await h.db
        .insert(sinks)
        .values({ pluginId, label: "Sink", config: {} })
        .returning();
      await h.db.insert(topicSinks).values({ topicId, sinkId: sink!.id });
      return sink!;
    }

    it("delivers to each enabled sink and records the external ref", async () => {
      const { topic, digestId } = await readyDigest();
      await attachSink(topic.id);
      const registry = new PluginRegistry().registerSink(fakeSink());

      const outcomes = await deliverDigest({ db: h.db, registry }, digestId);

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        status: "delivered",
        externalRef: "msg-1",
      });

      const rows = await h.db.select().from(deliveries);
      expect(rows[0]).toMatchObject({
        status: "delivered",
        externalRef: "msg-1",
      });
    });

    it("records a per-sink failure without failing the others", async () => {
      const { topic, digestId } = await readyDigest();
      await attachSink(topic.id, "good-sink");
      await attachSink(topic.id, "bad-sink");

      const registry = new PluginRegistry()
        .registerSink(fakeSink({ id: "good-sink" }))
        .registerSink(
          fakeSink({
            id: "bad-sink",
            deliver: async () => {
              throw new Error("telegram down");
            },
          }),
        );

      const outcomes = await deliverDigest({ db: h.db, registry }, digestId);

      expect(outcomes.filter((o) => o.status === "delivered")).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === "failed")).toHaveLength(1);
      expect(await h.db.select().from(deliveries)).toHaveLength(2);
    });

    it("is idempotent per sink: a retry updates rather than duplicates", async () => {
      const { topic, digestId } = await readyDigest();
      await attachSink(topic.id);
      const registry = new PluginRegistry().registerSink(fakeSink());
      const deps = { db: h.db, registry };

      await deliverDigest(deps, digestId);
      await deliverDigest(deps, digestId);

      expect(await h.db.select().from(deliveries)).toHaveLength(1);
    });

    it("only hands a sink the artifact kinds it accepts", async () => {
      const { topic, digestId } = await readyDigest();
      await attachSink(topic.id);
      await h.db.insert(artifacts).values({
        digestId,
        kind: "audio",
        mime: "audio/mpeg",
        path: "x.mp3",
        bytes: 100,
      });

      const deliver = vi.fn().mockResolvedValue({ externalRef: "r" });
      const registry = new PluginRegistry().registerSink(
        fakeSink({ accepts: ["text"], deliver }),
      );

      await deliverDigest({ db: h.db, registry }, digestId);

      const passed = deliver.mock.calls[0]![2] as { kind: string }[];
      expect(passed.map((a) => a.kind)).toEqual(["text"]);
    });

    it("skips disabled sinks", async () => {
      const { topic, digestId } = await readyDigest();
      const sink = await attachSink(topic.id);
      await h.db
        .update(sinks)
        .set({ enabled: false })
        .where(eq(sinks.id, sink.id));

      const registry = new PluginRegistry().registerSink(fakeSink());
      expect(await deliverDigest({ db: h.db, registry }, digestId)).toHaveLength(
        0,
      );
    });

    it("refuses to deliver a digest that is not ready", async () => {
      const topic = await seedTopic();
      const [digest] = await h.db
        .insert(digests)
        .values({ topicId: topic.id, jobKey: "k", rendererId: "fake-renderer" })
        .returning();

      await expect(
        deliverDigest(
          { db: h.db, registry: new PluginRegistry() },
          digest!.id,
        ),
      ).rejects.toThrow(/Cannot deliver digest in status/);
    });
  });

  // -------------------------------------------------------------------------
  describe("end to end", () => {
    it("runs poll -> draft -> curate -> approve -> render -> deliver", async () => {
      const topic = await seedTopic({ curationMode: "manual" });
      const source = await seedSource();
      await h.db
        .insert(topicSources)
        .values({ topicId: topic.id, sourceId: source.id });
      await h.db
        .insert(keywords)
        .values({ topicId: topic.id, term: "AI", mode: "include" });

      const [sink] = await h.db
        .insert(sinks)
        .values({ pluginId: "fake-sink", label: "TG", config: {} })
        .returning();
      await h.db.insert(topicSinks).values({ topicId: topic.id, sinkId: sink!.id });

      const registry = new PluginRegistry()
        .registerSource(
          fakeSource({
            fetch: async () => ({
              items: [
                fakeItem(1, { title: "AI breakthrough" }),
                fakeItem(2, { title: "AI safety debate" }),
                fakeItem(3, { title: "Gardening tips" }),
              ],
              cursor: { etag: "e1" },
            }),
          }),
        )
        .registerRenderer(fakeRenderer())
        .registerSink(fakeSink());

      const deps = { db: h.db, registry };

      // 1. poll
      const ingested = await ingestAll(deps);
      expect(ingested[0]!.inserted).toBe(3);

      // 2. draft: keyword filter drops the gardening item
      const draft = await buildDraft(deps, topic.id);
      expect(draft.candidates).toBe(3);
      expect(draft.matched).toBe(2);

      // 3. curate: drop one of the two matches
      const links = await h.db
        .select({ itemId: digestItems.itemId, title: items.title })
        .from(digestItems)
        .innerJoin(items, eq(items.id, digestItems.itemId))
        .where(eq(digestItems.digestId, draft.digestId!));
      const toDrop = links.find((l) => l.title === "AI safety debate")!;
      await setItemIncluded(h.db, draft.digestId!, toDrop.itemId, false);

      // 4. approve
      await approveDigest(h.db, draft.digestId!);

      // 5. render: only the single curated item reaches the renderer
      const rendered = await renderDigest(deps, draft.digestId!);
      expect(rendered.status).toBe("ready");
      const [finalDigest] = await h.db
        .select()
        .from(digests)
        .where(eq(digests.id, draft.digestId!));
      expect(finalDigest!.summary).toBe("summary of 1");

      // 6. deliver
      const outcomes = await deliverDigest(deps, draft.digestId!);
      expect(outcomes).toEqual([
        { sinkId: sink!.id, status: "delivered", externalRef: "msg-1" },
      ]);

      // quota accounting recorded exactly one render
      expect(await h.db.select().from(renderLog)).toHaveLength(1);
    });
  });
});
