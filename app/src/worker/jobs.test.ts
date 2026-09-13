import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, type TestDb } from "../db/testing.js";
import {
  artifacts,
  digests,
  items,
  keywords,
  settings,
  sinks,
  sources,
  topicSinks,
  topicSources,
  topics,
} from "../db/schema.js";
import { PluginRegistry } from "../core/registry.js";
import type {
  NormalizedItem,
  RendererPlugin,
  SinkPlugin,
  SourcePlugin,
} from "../core/types.js";
import {
  dashboardCounts,
  ensureSettings,
  pendingDrafts,
  pollAllSources,
  renderAndDeliver,
  runRetention,
  runTopicCycle,
  scheduledTopics,
  type JobDeps,
} from "./jobs.js";

function sourcePlugin(items: NormalizedItem[]): SourcePlugin<{ url: string }> {
  return {
    kind: "source",
    id: "fake",
    label: "Fake",
    description: "test double",
    configSchema: z.object({ url: z.string().url() }),
    capabilities: { pollable: true, supportsCursor: false },
    fetch: async () => ({ items, cursor: null }),
  } as SourcePlugin<{ url: string }>;
}

function rendererPlugin(
  over: Partial<RendererPlugin<Record<string, never>>> = {},
): RendererPlugin<Record<string, never>> {
  return {
    kind: "renderer",
    id: "fake-renderer",
    label: "Fake",
    description: "test double",
    configSchema: z.object({}).passthrough(),
    produces: { text: true, audio: false },
    render: async (_c, input) => ({
      summary: `rendered ${input.items.length}`,
      artifacts: [{ kind: "text", mime: "text/plain", text: "body" }],
    }),
    ...over,
  } as RendererPlugin<Record<string, never>>;
}

function sinkPlugin(
  over: Partial<SinkPlugin<Record<string, never>>> = {},
): SinkPlugin<Record<string, never>> {
  return {
    kind: "sink",
    id: "fake-sink",
    label: "Fake",
    description: "test double",
    configSchema: z.object({}).passthrough(),
    accepts: ["text", "audio"],
    deliver: async () => ({ externalRef: "ref-1" }),
    ...over,
  } as SinkPlugin<Record<string, never>>;
}

describe("worker jobs", () => {
  let h: TestDb;
  let logs: Record<string, unknown>[];

  beforeEach(async () => {
    h = await createTestDb();
    logs = [];
  });

  afterEach(async () => {
    await h.close();
  });

  function deps(registry: PluginRegistry, over: Partial<JobDeps> = {}): JobDeps {
    return {
      db: h.db,
      registry,
      log: (e) => logs.push(e),
      ...over,
    };
  }

  async function seedTopicWithSource(
    curationMode: "auto" | "manual",
    itemTitles = ["AI news"],
  ) {
    const [topic] = await h.db
      .insert(topics)
      .values({
        name: "T",
        slug: `t-${Math.random().toString(36).slice(2, 8)}`,
        curationMode,
        rendererId: "fake-renderer",
      })
      .returning();
    const [source] = await h.db
      .insert(sources)
      .values({
        pluginId: "fake",
        label: "F",
        config: { url: "https://e.com/f" },
      })
      .returning();
    await h.db
      .insert(topicSources)
      .values({ topicId: topic!.id, sourceId: source!.id });

    await h.db.insert(items).values(
      itemTitles.map((title, i) => ({
        sourceId: source!.id,
        externalId: `e-${i}`,
        url: `https://e.com/${i}`,
        title,
        publishedAt: new Date(),
      })),
    );
    return { topic: topic!, source: source! };
  }

  // -------------------------------------------------------------------------
  describe("pollAllSources", () => {
    it("ingests from every enabled source and reports totals", async () => {
      await h.db.insert(sources).values({
        pluginId: "fake",
        label: "F",
        config: { url: "https://e.com/f" },
      });
      const registry = new PluginRegistry().registerSource(
        sourcePlugin([
          {
            externalId: "a",
            url: "https://e.com/a",
            title: "A",
            publishedAt: new Date(),
            raw: {},
          },
        ]),
      );

      const result = await pollAllSources(deps(registry));

      expect(result).toMatchObject({ sources: 1, inserted: 1, failed: 0 });
      expect(logs.some((l) => l.job === "poll-all")).toBe(true);
    });

    it("counts failures without throwing", async () => {
      await h.db.insert(sources).values({
        pluginId: "missing-plugin",
        label: "F",
        config: {},
      });

      const result = await pollAllSources(deps(new PluginRegistry()));

      expect(result.failed).toBe(1);
      expect(result.inserted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("runTopicCycle", () => {
    it("stops at the draft for a manual topic (the approval gate holds)", async () => {
      const { topic } = await seedTopicWithSource("manual");
      const render = vi.fn();
      const registry = new PluginRegistry().registerRenderer(
        rendererPlugin({ render }),
      );

      const result = await runTopicCycle(deps(registry), topic.id);

      expect(result.outcome).toBe("draft-awaiting-curation");
      expect(render).not.toHaveBeenCalled();

      const [digest] = await h.db.select().from(digests);
      expect(digest!.status).toBe("draft");
    });

    it("renders and delivers end to end for an auto topic", async () => {
      const { topic } = await seedTopicWithSource("auto");
      const [sink] = await h.db
        .insert(sinks)
        .values({ pluginId: "fake-sink", label: "S", config: {} })
        .returning();
      await h.db
        .insert(topicSinks)
        .values({ topicId: topic.id, sinkId: sink!.id });

      const registry = new PluginRegistry()
        .registerRenderer(rendererPlugin())
        .registerSink(sinkPlugin());

      const result = await runTopicCycle(deps(registry), topic.id);

      expect(result.outcome).toBe("rendered");
      const [digest] = await h.db.select().from(digests);
      expect(digest!.status).toBe("ready");
      expect(digest!.summary).toBe("rendered 1");
    });

    it("reports no-items when the topic has nothing new", async () => {
      const [topic] = await h.db
        .insert(topics)
        .values({ name: "Empty", slug: "empty", rendererId: "fake-renderer" })
        .returning();

      const result = await runTopicCycle(
        deps(new PluginRegistry()),
        topic!.id,
      );
      expect(result.outcome).toBe("no-items");
      expect(result.digestId).toBeNull();
    });

    it("reports no-matches when keywords exclude everything", async () => {
      const { topic } = await seedTopicWithSource("auto", ["Gardening"]);
      await h.db
        .insert(keywords)
        .values({ topicId: topic.id, term: "quantum", mode: "include" });

      const result = await runTopicCycle(
        deps(new PluginRegistry()),
        topic.id,
      );
      expect(result.outcome).toBe("no-matches");
    });

    it("surfaces a render failure instead of pretending to succeed", async () => {
      const { topic } = await seedTopicWithSource("auto");
      const registry = new PluginRegistry().registerRenderer(
        rendererPlugin({
          render: async () => {
            throw new Error("upstream down");
          },
        }),
      );

      const result = await runTopicCycle(deps(registry), topic.id);

      expect(result.outcome).toBe("render-failed");
      expect(result.detail).toBe("upstream down");
    });

    it("reports render-skipped when the budget blocks it", async () => {
      const { topic } = await seedTopicWithSource("auto");
      const registry = new PluginRegistry().registerRenderer(
        rendererPlugin({ dailyBudget: 0 }),
      );

      const result = await runTopicCycle(deps(registry), topic.id);
      expect(result.outcome).toBe("render-skipped");
    });
  });

  // -------------------------------------------------------------------------
  describe("renderAndDeliver", () => {
    it("approves a draft before rendering it", async () => {
      const { topic } = await seedTopicWithSource("manual");
      const registry = new PluginRegistry().registerRenderer(rendererPlugin());
      const d = deps(registry);

      await runTopicCycle(d, topic.id);
      const [draft] = await h.db.select().from(digests);
      expect(draft!.status).toBe("draft");

      const result = await renderAndDeliver(d, draft!.id);

      expect(result.rendered.status).toBe("ready");
      const [after] = await h.db
        .select()
        .from(digests)
        .where(eq(digests.id, draft!.id));
      expect(after!.status).toBe("ready");
    });

    it("throws for an unknown digest", async () => {
      await expect(
        renderAndDeliver(
          deps(new PluginRegistry()),
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toThrow(/Unknown digest/);
    });
  });

  // -------------------------------------------------------------------------
  describe("runRetention", () => {
    async function seedOldArtifact(ageDays: number, path = "old.mp3") {
      const [topic] = await h.db
        .insert(topics)
        .values({
          name: "T",
          slug: `t-${Math.random().toString(36).slice(2, 8)}`,
          rendererId: "r",
        })
        .returning();
      const [digest] = await h.db
        .insert(digests)
        .values({
          topicId: topic!.id,
          jobKey: `k-${Math.random()}`,
          rendererId: "r",
        })
        .returning();
      await h.db.insert(artifacts).values({
        digestId: digest!.id,
        kind: "audio",
        mime: "audio/mpeg",
        path,
        bytes: 1,
        createdAt: new Date(Date.now() - ageDays * 86_400_000),
      });
    }

    it("deletes artifacts and their files past the retention window", async () => {
      await ensureSettings(h.db);
      await seedOldArtifact(45);
      const removeFile = vi.fn().mockResolvedValue(undefined);

      const result = await runRetention(
        deps(new PluginRegistry(), { removeFile }),
      );

      expect(result.artifactsRemoved).toBe(1);
      expect(result.filesDeleted).toBe(1);
      expect(removeFile).toHaveBeenCalledWith("old.mp3");
      expect(await h.db.select().from(artifacts)).toHaveLength(0);
    });

    it("keeps artifacts inside the window", async () => {
      await ensureSettings(h.db);
      await seedOldArtifact(5);
      const removeFile = vi.fn().mockResolvedValue(undefined);

      const result = await runRetention(
        deps(new PluginRegistry(), { removeFile }),
      );

      expect(result.artifactsRemoved).toBe(0);
      expect(removeFile).not.toHaveBeenCalled();
    });

    it("still clears the row when the file is already gone", async () => {
      // Retention must be re-runnable; a missing mp3 cannot wedge it.
      await ensureSettings(h.db);
      await seedOldArtifact(45);
      const removeFile = vi.fn().mockRejectedValue(new Error("ENOENT"));

      const result = await runRetention(
        deps(new PluginRegistry(), { removeFile }),
      );

      expect(result.artifactsRemoved).toBe(1);
      expect(result.filesDeleted).toBe(0);
      expect(await h.db.select().from(artifacts)).toHaveLength(0);
      expect(logs.some((l) => l.warn)).toBe(true);
    });

    it("honours a custom retentionDays from settings", async () => {
      await ensureSettings(h.db);
      await h.db.update(settings).set({ retentionDays: 90 });
      await seedOldArtifact(45);

      const result = await runRetention(
        deps(new PluginRegistry(), { removeFile: vi.fn() }),
      );
      expect(result.artifactsRemoved).toBe(0);
    });

    it("prunes stale items", async () => {
      await ensureSettings(h.db);
      const [source] = await h.db
        .insert(sources)
        .values({ pluginId: "fake", label: "F", config: {} })
        .returning();
      await h.db.insert(items).values({
        sourceId: source!.id,
        externalId: "old",
        url: "https://e.com/old",
        title: "Old",
        publishedAt: new Date(),
        fetchedAt: new Date(Date.now() - 60 * 86_400_000),
      });

      const result = await runRetention(
        deps(new PluginRegistry(), { removeFile: vi.fn() }),
      );
      expect(result.itemsRemoved).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("scheduling helpers", () => {
    it("falls back to the global schedule when a topic has none", async () => {
      await ensureSettings(h.db);
      await h.db
        .insert(topics)
        .values({ name: "A", slug: "a", rendererId: "r" });
      await h.db.insert(topics).values({
        name: "B",
        slug: "b",
        rendererId: "r",
        schedule: "0 9 * * 1",
      });

      const scheduled = await scheduledTopics(h.db);
      const byName = Object.fromEntries(
        scheduled.map((s) => [s.topic.name, s.schedule]),
      );

      expect(byName.A).toBe("0 7 * * *");
      expect(byName.B).toBe("0 9 * * 1");
    });

    it("excludes disabled topics from scheduling", async () => {
      await ensureSettings(h.db);
      await h.db
        .insert(topics)
        .values({ name: "Off", slug: "off", rendererId: "r", enabled: false });

      expect(await scheduledTopics(h.db)).toHaveLength(0);
    });

    it("ensureSettings is idempotent", async () => {
      await ensureSettings(h.db);
      await ensureSettings(h.db);
      expect(await h.db.select().from(settings)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("dashboard helpers", () => {
    it("counts topics, items and digests", async () => {
      await seedTopicWithSource("manual", ["a", "b"]);
      const counts = await dashboardCounts(h.db);
      expect(counts).toMatchObject({ topics: 1, items: 2, digests: 0 });
    });

    it("lists drafts awaiting curation", async () => {
      const { topic } = await seedTopicWithSource("manual");
      await runTopicCycle(deps(new PluginRegistry()), topic.id);
      expect(await pendingDrafts(h.db)).toHaveLength(1);
    });
  });
});
