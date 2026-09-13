import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/testing.js";
import type { Database } from "../db/client.js";
import {
  digestItems,
  digests,
  items,
  keywords,
  sources,
  topicSinks,
  topicSources,
  topics,
} from "../db/schema.js";
import { registry } from "../plugins.js";
import { approveDigest, setItemIncluded } from "../pipeline/digest.js";
import {
  addKeyword,
  attachSink,
  attachSource,
  createSink,
  createSource,
  createTopic,
  deleteSource,
  detachSource,
  loadPluginToggles,
  loadSettings,
  removeKeyword,
  saveSettings,
  setPluginEnabled,
  setSourceEnabled,
  setTopicRenderer,
  slugify,
  updateTopic,
} from "./mutations.js";

/**
 * These exercise the write layer the Server Actions delegate to, against a
 * real Postgres (pglite). The actions themselves are one-line wrappers that
 * add db() and revalidatePath().
 */

let harness: TestDb;
let db: Database;

beforeEach(async () => {
  harness = await createTestDb();
  db = harness.db as unknown as Database;
});

afterEach(async () => {
  await harness.close();
});

const reg = registry();

async function aSource(label = "Example feed") {
  return createSource(
    db,
    {
      pluginId: "rss",
      label,
      config: { url: "https://example.com/feed.xml" },
    },
    reg,
  );
}

describe("slugify", () => {
  it("makes a url-safe slug", () => {
    expect(slugify("AI News & Papers")).toBe("ai-news-papers");
    expect(slugify("  Kubernetes  ")).toBe("kubernetes");
  });
});

describe("createTopic", () => {
  it("creates a topic with a derived slug and the given settings", async () => {
    const topic = await createTopic(db, {
      name: "AI News",
      description: "Daily AI roundup",
      schedule: "0 7 * * *",
      curationMode: "manual",
      rendererId: "llm-text",
    });

    expect(topic.slug).toBe("ai-news");
    expect(topic.name).toBe("AI News");
    expect(topic.description).toBe("Daily AI roundup");
    expect(topic.curationMode).toBe("manual");
    expect(topic.enabled).toBe(true);

    const stored = await db.select().from(topics);
    expect(stored).toHaveLength(1);
  });

  it("suffixes a colliding slug rather than failing the unique index", async () => {
    await createTopic(db, { name: "AI News" });
    const second = await createTopic(db, { name: "AI News" });
    expect(second.slug).toBe("ai-news-2");
  });

  it("rejects a blank name", async () => {
    await expect(createTopic(db, { name: "   " })).rejects.toThrow(
      /name is required/i,
    );
  });

  it("stores an empty description as null, not an empty string", async () => {
    const topic = await createTopic(db, { name: "Empty", description: "  " });
    expect(topic.description).toBeNull();
  });
});

describe("updateTopic", () => {
  it("patches only the supplied fields", async () => {
    const topic = await createTopic(db, { name: "Rust", schedule: "0 7 * * *" });
    await updateTopic(db, topic.id, { curationMode: "auto", enabled: false });

    const [after] = await db.select().from(topics).where(eq(topics.id, topic.id));
    expect(after!.curationMode).toBe("auto");
    expect(after!.enabled).toBe(false);
    expect(after!.schedule).toBe("0 7 * * *");
    expect(after!.name).toBe("Rust");
  });
});

describe("setTopicRenderer", () => {
  it("validates the renderer config against the plugin schema", async () => {
    const topic = await createTopic(db, { name: "AI" });

    await setTopicRenderer(
      db,
      topic.id,
      "llm-text",
      { provider: "ollama", model: "llama3" },
      reg,
    );

    const [after] = await db.select().from(topics).where(eq(topics.id, topic.id));
    expect(after!.rendererId).toBe("llm-text");
    expect(after!.rendererConfig).toMatchObject({ provider: "ollama" });

    await expect(
      setTopicRenderer(db, topic.id, "llm-text", { provider: "nope" }, reg),
    ).rejects.toThrow(/provider/);
  });

  it("refuses an unknown renderer id", async () => {
    const topic = await createTopic(db, { name: "AI" });
    await expect(
      setTopicRenderer(db, topic.id, "not-real", {}, reg),
    ).rejects.toThrow(/Unknown renderer/);
  });
});

describe("createSource", () => {
  it("validates the config with the plugin schema before storing", async () => {
    const source = await aSource();
    expect(source.pluginId).toBe("rss");
    expect(source.config).toEqual({ url: "https://example.com/feed.xml" });
    expect(source.enabled).toBe(true);
  });

  it("rejects a config the plugin schema does not accept", async () => {
    await expect(
      createSource(db, { pluginId: "rss", label: "Bad", config: { url: "nope" } }, reg),
    ).rejects.toThrow(/url/i);
  });

  it("rejects an unknown plugin id", async () => {
    await expect(
      createSource(db, { pluginId: "ghost", label: "x", config: {} }, reg),
    ).rejects.toThrow(/Unknown source plugin/);
  });

  it("enables and disables an instance", async () => {
    const source = await aSource();
    await setSourceEnabled(db, source.id, false);
    const [after] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(after!.enabled).toBe(false);
  });
});

describe("attach / detach source", () => {
  it("attaches a source to a topic", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const source = await aSource();

    await attachSource(db, topic.id, source.id);

    const links = await db
      .select()
      .from(topicSources)
      .where(eq(topicSources.topicId, topic.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.sourceId).toBe(source.id);
  });

  it("is idempotent: attaching twice does not violate the primary key", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const source = await aSource();

    await attachSource(db, topic.id, source.id);
    await attachSource(db, topic.id, source.id);

    const links = await db.select().from(topicSources);
    expect(links).toHaveLength(1);
  });

  it("detaches without deleting the source itself", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const source = await aSource();
    await attachSource(db, topic.id, source.id);

    await detachSource(db, topic.id, source.id);

    expect(await db.select().from(topicSources)).toHaveLength(0);
    expect(await db.select().from(sources)).toHaveLength(1);
  });

  it("lets one source feed several topics", async () => {
    const ai = await createTopic(db, { name: "AI" });
    const rust = await createTopic(db, { name: "Rust" });
    const source = await aSource();

    await attachSource(db, ai.id, source.id);
    await attachSource(db, rust.id, source.id);

    expect(await db.select().from(topicSources)).toHaveLength(2);
  });

  it("cascades the link away when the source is deleted", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const source = await aSource();
    await attachSource(db, topic.id, source.id);

    await deleteSource(db, source.id);

    expect(await db.select().from(topicSources)).toHaveLength(0);
  });
});

describe("sinks", () => {
  it("creates and attaches a sink", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const sink = await createSink(
      db,
      {
        pluginId: "telegram",
        label: "My channel",
        config: { botToken: "123:abc", chatId: "@mychannel" },
      },
      reg,
    );

    await attachSink(db, topic.id, sink.id);

    const links = await db
      .select()
      .from(topicSinks)
      .where(eq(topicSinks.topicId, topic.id));
    expect(links).toHaveLength(1);
  });
});

describe("keywords", () => {
  it("adds include and exclude rules", async () => {
    const topic = await createTopic(db, { name: "AI" });

    const include = await addKeyword(db, topic.id, "  transformer ", "include");
    await addKeyword(db, topic.id, "crypto", "exclude");

    expect(include.term).toBe("transformer");

    const rows = await db
      .select()
      .from(keywords)
      .where(eq(keywords.topicId, topic.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.mode).sort()).toEqual(["exclude", "include"]);
  });

  it("defaults an unrecognised mode to include", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const row = await addKeyword(db, topic.id, "llm", "wat");
    expect(row.mode).toBe("include");
  });

  it("rejects a blank term", async () => {
    const topic = await createTopic(db, { name: "AI" });
    await expect(addKeyword(db, topic.id, "   ", "include")).rejects.toThrow(
      /term is required/i,
    );
  });

  it("removes a rule", async () => {
    const topic = await createTopic(db, { name: "AI" });
    const row = await addKeyword(db, topic.id, "llm", "include");

    await removeKeyword(db, row.id);

    expect(await db.select().from(keywords)).toHaveLength(0);
  });
});

describe("curation gate", () => {
  async function aDraft() {
    const topic = await createTopic(db, { name: "AI" });
    const source = await aSource();
    await attachSource(db, topic.id, source.id);

    const [item] = await db
      .insert(items)
      .values({
        sourceId: source.id,
        externalId: "a1",
        url: "https://example.com/a",
        title: "A new model",
        publishedAt: new Date("2024-05-01T00:00:00Z"),
      })
      .returning();

    const [digest] = await db
      .insert(digests)
      .values({
        topicId: topic.id,
        jobKey: `${topic.id}:draft`,
        rendererId: "llm-text",
        status: "draft",
      })
      .returning();

    await db
      .insert(digestItems)
      .values({ digestId: digest!.id, itemId: item!.id, included: true });

    return { digestId: digest!.id, itemId: item!.id };
  }

  it("toggles an item in and out of the digest", async () => {
    const { digestId, itemId } = await aDraft();

    await setItemIncluded(db, digestId, itemId, false);
    let [row] = await db
      .select()
      .from(digestItems)
      .where(eq(digestItems.digestId, digestId));
    expect(row!.included).toBe(false);

    await setItemIncluded(db, digestId, itemId, true);
    [row] = await db
      .select()
      .from(digestItems)
      .where(eq(digestItems.digestId, digestId));
    expect(row!.included).toBe(true);
  });

  it("approves a draft that has a selection", async () => {
    const { digestId } = await aDraft();

    await approveDigest(db, digestId);

    const [row] = await db.select().from(digests).where(eq(digests.id, digestId));
    expect(row!.status).toBe("approved");
  });

  it("refuses to approve when nothing is selected", async () => {
    const { digestId, itemId } = await aDraft();
    await setItemIncluded(db, digestId, itemId, false);

    await expect(approveDigest(db, digestId)).rejects.toThrow(
      /no included items/i,
    );

    const [row] = await db.select().from(digests).where(eq(digests.id, digestId));
    expect(row!.status).toBe("draft");
  });
});

describe("settings", () => {
  it("returns defaults before anything is saved", async () => {
    expect(await loadSettings(db)).toEqual({
      defaultSchedule: "0 7 * * *",
      defaultCurationMode: "manual",
      retentionDays: 30,
    });
  });

  it("saves and then updates the singleton row", async () => {
    await saveSettings(db, {
      defaultSchedule: "30 6 * * *",
      defaultCurationMode: "auto",
      retentionDays: 7,
    });
    expect(await loadSettings(db)).toEqual({
      defaultSchedule: "30 6 * * *",
      defaultCurationMode: "auto",
      retentionDays: 7,
    });

    await saveSettings(db, { retentionDays: 14 });
    expect(await loadSettings(db)).toEqual({
      defaultSchedule: "30 6 * * *",
      defaultCurationMode: "auto",
      retentionDays: 14,
    });
  });

  it("toggles a plugin type on and off", async () => {
    await setPluginEnabled(db, "youtube-search", "source", false);
    let toggles = await loadPluginToggles(db);
    expect(toggles.get("source:youtube-search")).toBe(false);

    await setPluginEnabled(db, "youtube-search", "source", true);
    toggles = await loadPluginToggles(db);
    expect(toggles.get("source:youtube-search")).toBe(true);
  });
});
