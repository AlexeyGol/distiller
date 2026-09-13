import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, type TestDb } from "../db/testing.js";
import { sinks } from "../db/schema.js";
import { PluginRegistry } from "../core/registry.js";
import type { SinkPlugin } from "../core/types.js";
import { createSink, updateSinkConfig } from "./mutations.js";

/**
 * Sinks hold the credentials most likely to change over time: a bot token gets
 * rotated, a chat id was pasted wrong. Before updateSinkConfig the only fix was
 * delete-and-recreate, which also drops the delivery history and detaches the
 * sink from every topic.
 */

const testSink: SinkPlugin<{ botToken: string; chatId: string }> = {
  kind: "sink",
  id: "test-sink",
  label: "Test sink",
  description: "test double",
  configSchema: z.object({
    botToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  accepts: ["text", "audio"],
  deliver: async () => ({ externalRef: "ref" }),
} as SinkPlugin<{ botToken: string; chatId: string }>;

function reg(): PluginRegistry {
  return new PluginRegistry().registerSink(testSink);
}

describe("updateSinkConfig", () => {
  let h: TestDb;

  beforeEach(async () => {
    h = await createTestDb();
  });

  afterEach(async () => {
    await h.close();
  });

  async function seed() {
    return createSink(
      h.db,
      {
        pluginId: "test-sink",
        label: "Telegram",
        config: { botToken: "old-token", chatId: "-1001" },
      },
      reg(),
    );
  }

  it("replaces the config, which is the token-rotation case", async () => {
    const sink = await seed();

    await updateSinkConfig(
      h.db,
      sink.id,
      "Telegram",
      { botToken: "new-token", chatId: "-1001" },
      reg(),
    );

    const [row] = await h.db.select().from(sinks).where(eq(sinks.id, sink.id));
    expect(row!.config).toEqual({ botToken: "new-token", chatId: "-1001" });
  });

  it("renames without touching the config", async () => {
    const sink = await seed();

    await updateSinkConfig(
      h.db,
      sink.id,
      "Team channel",
      { botToken: "old-token", chatId: "-1001" },
      reg(),
    );

    const [row] = await h.db.select().from(sinks).where(eq(sinks.id, sink.id));
    expect(row!.label).toBe("Team channel");
  });

  it("keeps the existing label when a blank one is submitted", async () => {
    // An empty field should not silently erase the name of a sink.
    const sink = await seed();

    await updateSinkConfig(
      h.db,
      sink.id,
      "   ",
      { botToken: "t", chatId: "c" },
      reg(),
    );

    const [row] = await h.db.select().from(sinks).where(eq(sinks.id, sink.id));
    expect(row!.label).toBe("Telegram");
  });

  it("rejects a config the plugin schema refuses, leaving the row unchanged", async () => {
    const sink = await seed();

    await expect(
      updateSinkConfig(h.db, sink.id, "Telegram", { botToken: "" }, reg()),
    ).rejects.toThrow();

    const [row] = await h.db.select().from(sinks).where(eq(sinks.id, sink.id));
    expect(row!.config).toEqual({ botToken: "old-token", chatId: "-1001" });
  });

  it("throws for an unknown sink id", async () => {
    await expect(
      updateSinkConfig(
        h.db,
        "00000000-0000-0000-0000-000000000000",
        "x",
        { botToken: "t", chatId: "c" },
        reg(),
      ),
    ).rejects.toThrow(/Unknown sink/);
  });

  it("does not change the plugin id", async () => {
    // A config validated against one plugin's schema is meaningless to another,
    // so the plugin is fixed at creation time.
    const sink = await seed();

    await updateSinkConfig(
      h.db,
      sink.id,
      "Telegram",
      { botToken: "t", chatId: "c" },
      reg(),
    );

    const [row] = await h.db.select().from(sinks).where(eq(sinks.id, sink.id));
    expect(row!.pluginId).toBe("test-sink");
  });

  it("preserves enabled state across an edit", async () => {
    const sink = await seed();
    await h.db.update(sinks).set({ enabled: false }).where(eq(sinks.id, sink.id));

    await updateSinkConfig(
      h.db,
      sink.id,
      "Telegram",
      { botToken: "t", chatId: "c" },
      reg(),
    );

    const [row] = await h.db.select().from(sinks).where(eq(sinks.id, sink.id));
    expect(row!.enabled).toBe(false);
  });
});
