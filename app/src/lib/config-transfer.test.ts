import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, type TestDb } from "../db/testing.js";
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
import { PluginRegistry } from "../core/registry.js";
import type { RendererPlugin, SinkPlugin, SourcePlugin } from "../core/types.js";
import {
  CONFIG_VERSION,
  REDACTED,
  exportConfig,
  importConfig,
  redactConfig,
  type ConfigBundle,
} from "./config-transfer.js";

const feedSource = {
  kind: "source",
  id: "feed",
  label: "Feed",
  description: "d",
  configSchema: z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
  }),
  capabilities: { pollable: true, supportsCursor: true },
  fetch: async () => ({ items: [], cursor: null }),
} as unknown as SourcePlugin<{ url: string; apiKey?: string }>;

const chatSink = {
  kind: "sink",
  id: "chat",
  label: "Chat",
  description: "d",
  configSchema: z.object({ botToken: z.string().min(1), chatId: z.string() }),
  accepts: ["text", "audio"],
  deliver: async () => ({}),
} as unknown as SinkPlugin<{ botToken: string; chatId: string }>;

const textRenderer = {
  kind: "renderer",
  id: "text",
  label: "Text",
  description: "d",
  configSchema: z.object({}).passthrough(),
  produces: { text: true, audio: false },
  render: async () => ({ summary: "", artifacts: [] }),
} as unknown as RendererPlugin<Record<string, never>>;

function reg(): PluginRegistry {
  return new PluginRegistry()
    .registerSource(feedSource)
    .registerSink(chatSink)
    .registerRenderer(textRenderer);
}

describe("redactConfig", () => {
  it("replaces credential-shaped fields and keeps the rest", () => {
    expect(
      redactConfig({ url: "https://e.com", apiKey: "AIzaREAL", limit: 25 }),
    ).toEqual({ url: "https://e.com", apiKey: REDACTED, limit: 25 });
  });

  it("leaves an empty secret visible, since it carries nothing", () => {
    // Distinguishing "not set" from "hidden" matters when debugging.
    expect(redactConfig({ apiKey: "" })).toEqual({ apiKey: "" });
  });

  it("catches camelCase credential names", () => {
    expect(redactConfig({ botToken: "123:AAH" }).botToken).toBe(REDACTED);
  });
});

describe("config export and import", () => {
  let h: TestDb;

  beforeEach(async () => {
    h = await createTestDb();
  });

  afterEach(async () => {
    await h.close();
  });

  async function seedFullConfig() {
    await h.db.insert(settings).values({ id: "global", retentionDays: 45 });
    await h.db
      .insert(pluginSettings)
      .values({ pluginId: "feed", kind: "source", enabled: true });

    const [source] = await h.db
      .insert(sources)
      .values({
        pluginId: "feed",
        label: "My Feed",
        config: { url: "https://e.com/f", apiKey: "SECRET-KEY-VALUE" },
      })
      .returning();

    const [sink] = await h.db
      .insert(sinks)
      .values({
        pluginId: "chat",
        label: "My Chat",
        config: { botToken: "123:SECRET", chatId: "-100" },
      })
      .returning();

    const [topic] = await h.db
      .insert(topics)
      .values({
        name: "AI News",
        slug: "ai-news",
        rendererId: "text",
        schedule: "0 7 * * *",
        curationMode: "manual",
      })
      .returning();

    await h.db
      .insert(topicSources)
      .values({ topicId: topic!.id, sourceId: source!.id });
    await h.db
      .insert(topicSinks)
      .values({ topicId: topic!.id, sinkId: sink!.id });
    await h.db.insert(keywords).values([
      { topicId: topic!.id, term: "ai", mode: "include" },
      { topicId: topic!.id, term: "sponsored", mode: "exclude" },
    ]);

    return { source: source!, sink: sink!, topic: topic! };
  }

  // -------------------------------------------------------------------------
  describe("export", () => {
    it("redacts secrets BY DEFAULT", async () => {
      // The safe behaviour must be the one you get without thinking. Sharing
      // or committing an export must not leak a token.
      await seedFullConfig();
      const bundle = await exportConfig(h.db);

      expect(bundle.secretsIncluded).toBe(false);
      expect(bundle.sources[0]!.config.apiKey).toBe(REDACTED);
      expect(bundle.sinks[0]!.config.botToken).toBe(REDACTED);
      expect(JSON.stringify(bundle)).not.toContain("SECRET-KEY-VALUE");
      expect(JSON.stringify(bundle)).not.toContain("123:SECRET");
    });

    it("includes secrets only when explicitly asked", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db, { includeSecrets: true });

      expect(bundle.secretsIncluded).toBe(true);
      expect(bundle.sources[0]!.config.apiKey).toBe("SECRET-KEY-VALUE");
    });

    it("keeps non-secret config visible either way", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db);
      expect(bundle.sources[0]!.config.url).toBe("https://e.com/f");
      expect(bundle.sinks[0]!.config.chatId).toBe("-100");
    });

    it("references sources and sinks by label, never by uuid", async () => {
      // Ids would collide or dangle on a different install; labels port.
      const { source } = await seedFullConfig();
      const bundle = await exportConfig(h.db);

      expect(bundle.topics[0]!.sources).toEqual(["My Feed"]);
      expect(JSON.stringify(bundle)).not.toContain(source.id);
    });

    it("carries keywords, schedule and curation mode", async () => {
      await seedFullConfig();
      const topic = (await exportConfig(h.db)).topics[0]!;

      expect(topic.keywords).toEqual([
        { term: "ai", mode: "include" },
        { term: "sponsored", mode: "exclude" },
      ]);
      expect(topic.schedule).toBe("0 7 * * *");
      expect(topic.curationMode).toBe("manual");
    });

    it("excludes accumulated history, which belongs in pg_dump", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db) as unknown as Record<string, unknown>;
      for (const key of ["items", "digests", "artifacts", "deliveries", "renderLog"]) {
        expect(bundle[key]).toBeUndefined();
      }
    });

    it("produces stable output for diffing", async () => {
      await seedFullConfig();
      const now = () => new Date("2026-01-01T00:00:00Z");
      const a = await exportConfig(h.db, { now });
      const b = await exportConfig(h.db, { now });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it("exports an empty install without throwing", async () => {
      const bundle = await exportConfig(h.db);
      expect(bundle.topics).toEqual([]);
      expect(bundle.settings).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("import", () => {
    async function roundTrip(includeSecrets = true) {
      await seedFullConfig();
      const bundle = await exportConfig(h.db, { includeSecrets });
      const fresh = await createTestDb();
      const result = await importConfig(fresh.db, bundle, { registry: reg() });
      return { fresh, bundle, result };
    }

    it("recreates a whole setup on an empty database", async () => {
      const { fresh, result } = await roundTrip();

      expect(result.sources.created).toBe(1);
      expect(result.sinks.created).toBe(1);
      expect(result.topics.created).toBe(1);

      const [topic] = await fresh.db.select().from(topics);
      expect(topic!.slug).toBe("ai-news");
      expect(await fresh.db.select().from(keywords)).toHaveLength(2);
      expect(await fresh.db.select().from(topicSources)).toHaveLength(1);
      expect(await fresh.db.select().from(topicSinks)).toHaveLength(1);

      await fresh.close();
    });

    it("restores real secrets from a bundle that has them", async () => {
      const { fresh } = await roundTrip(true);
      const [source] = await fresh.db.select().from(sources);
      expect((source!.config as Record<string, unknown>).apiKey).toBe(
        "SECRET-KEY-VALUE",
      );
      await fresh.close();
    });

    it("keeps existing secrets when importing a REDACTED bundle", async () => {
      // The key property: a safe-to-share export still round-trips onto a live
      // install without wiping the credentials already there.
      await seedFullConfig();
      const redactedBundle = await exportConfig(h.db);

      // Change something non-secret, then re-import the redacted bundle.
      redactedBundle.sources[0]!.config.url = "https://changed.example/feed";
      const result = await importConfig(h.db, redactedBundle, {
        registry: reg(),
      });

      const [source] = await h.db.select().from(sources);
      const config = source!.config as Record<string, unknown>;
      expect(config.url).toBe("https://changed.example/feed");
      expect(config.apiKey).toBe("SECRET-KEY-VALUE");
      expect(result.sources.updated).toBe(1);
    });

    it("warns, rather than fails, when a redacted secret has nothing to keep", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db);
      const fresh = await createTestDb();

      const result = await importConfig(fresh.db, bundle, { registry: reg() });

      expect(result.warnings.some((w) => w.includes("botToken"))).toBe(true);
      await fresh.close();
    });

    it("refuses a redacted bundle when requireSecrets is set", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db);

      await expect(
        importConfig(h.db, bundle, { registry: reg(), requireSecrets: true }),
      ).rejects.toThrow(/without secrets/);
    });

    it("is idempotent: importing twice updates rather than duplicating", async () => {
      const { fresh, bundle } = await roundTrip();
      const second = await importConfig(fresh.db, bundle, { registry: reg() });

      expect(second.sources.created).toBe(0);
      expect(second.sources.updated).toBe(1);
      expect(await fresh.db.select().from(topics)).toHaveLength(1);
      expect(await fresh.db.select().from(keywords)).toHaveLength(2);
      await fresh.close();
    });

    it("never deletes anything the bundle does not mention", async () => {
      await seedFullConfig();
      await h.db
        .insert(sources)
        .values({ pluginId: "feed", label: "Untouched", config: { url: "https://x.com/f" } });

      const bundle = await exportConfig(h.db, { includeSecrets: true });
      bundle.sources = bundle.sources.filter((s) => s.label !== "Untouched");
      await importConfig(h.db, bundle, { registry: reg() });

      const remaining = await h.db.select().from(sources);
      expect(remaining.map((s) => s.label).sort()).toEqual([
        "My Feed",
        "Untouched",
      ]);
    });

    it("replaces a topic's keywords rather than merging them", async () => {
      // Merging would make removing a keyword through an import impossible.
      await seedFullConfig();
      const bundle = await exportConfig(h.db, { includeSecrets: true });
      bundle.topics[0]!.keywords = [{ term: "only", mode: "include" }];

      await importConfig(h.db, bundle, { registry: reg() });

      const remaining = await h.db.select().from(keywords);
      expect(remaining.map((k) => k.term)).toEqual(["only"]);
    });

    it("skips an unknown plugin with a warning instead of throwing", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db, { includeSecrets: true });
      bundle.sources[0]!.pluginId = "not-a-plugin";

      const fresh = await createTestDb();
      const result = await importConfig(fresh.db, bundle, { registry: reg() });

      expect(result.sources.created).toBe(0);
      expect(result.warnings.some((w) => w.includes("not-a-plugin"))).toBe(true);
      await fresh.close();
    });

    it("skips a config that fails its plugin schema", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db, { includeSecrets: true });
      bundle.sources[0]!.config.url = "not-a-url";

      const fresh = await createTestDb();
      const result = await importConfig(fresh.db, bundle, { registry: reg() });

      expect(result.sources.created).toBe(0);
      expect(result.warnings.some((w) => w.includes("invalid"))).toBe(true);
      await fresh.close();
    });

    it("warns when a topic references a source that is not in the bundle", async () => {
      await seedFullConfig();
      const bundle = await exportConfig(h.db, { includeSecrets: true });
      bundle.sources = [];

      const fresh = await createTestDb();
      const result = await importConfig(fresh.db, bundle, { registry: reg() });

      expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
      await fresh.close();
    });

    it("rejects a bundle from a future version", async () => {
      const bundle = {
        ...(await exportConfig(h.db)),
        version: CONFIG_VERSION + 1,
      } as ConfigBundle;

      await expect(
        importConfig(h.db, bundle, { registry: reg() }),
      ).rejects.toThrow(/Unsupported config version/);
    });

    it("restores settings and plugin toggles", async () => {
      const { fresh } = await roundTrip();

      const [row] = await fresh.db.select().from(settings);
      expect(row!.retentionDays).toBe(45);
      expect(await fresh.db.select().from(pluginSettings)).toHaveLength(1);

      await fresh.close();
    });
  });
});
