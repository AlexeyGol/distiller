// MUST be the first import: ES imports are evaluated before any statement, so
// a loadEnv() call here would run too late for anything reading process.env at
// module scope. See src/env-init.ts.
import "../env-init.js";

import { eq } from "drizzle-orm";
import { createDatabase } from "./client.js";
import {
  keywords,
  pluginSettings,
  settings,
  sources,
  topicSources,
  topics,
} from "./schema.js";

/**
 * Seed a usable starting state so a fresh install has something to look at.
 *
 * Idempotent: re-running adds nothing. Everything keys off the topic slug and
 * source labels, so this is safe to run against an existing database.
 *
 * The feeds below are real and public. The youtube-search source is created
 * DISABLED because it needs a Data API key and each poll costs 100 units of a
 * 10,000/day quota - enabling it by default would silently burn someone's
 * quota before they had configured anything.
 */

interface SeedSource {
  pluginId: string;
  label: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}

const SEED = {
  topic: {
    name: "AI News",
    slug: "ai-news",
    description:
      "Developments in AI tooling, models and agents. Skips sponsored posts.",
    curationMode: "manual" as const,
    rendererId: "notebooklm-text",
    schedule: "0 7 * * *",
  },
  sources: [
    {
      pluginId: "rss",
      label: "Simon Willison",
      config: { url: "https://simonwillison.net/atom/everything/" },
    },
    {
      pluginId: "rss",
      label: "Hacker News front page",
      config: { url: "https://hnrss.org/frontpage" },
    },
    {
      pluginId: "youtube-channel",
      label: "Fireship",
      config: { channelId: "UCsBjURrPoezykLs9EqgamOA" },
    },
    {
      pluginId: "youtube-search",
      label: "YouTube: AI agents",
      // Disabled until a key is supplied: see the note above about quota.
      config: { apiKey: "", query: "AI agents", maxResults: 25 },
      enabled: false,
    },
  ] satisfies SeedSource[],
  keywords: [
    { term: "ai", mode: "include" },
    { term: "llm", mode: "include" },
    { term: "claude", mode: "include" },
    { term: "agent", mode: "include" },
    { term: "sponsored", mode: "exclude" },
  ],
};

async function main() {
  const db = createDatabase();

  await db.insert(settings).values({ id: "global" }).onConflictDoNothing();

  // Every plugin type on by default; the UI can toggle these off later.
  for (const [pluginId, kind] of [
    ["rss", "source"],
    ["youtube-channel", "source"],
    ["youtube-search", "source"],
    ["llm-text", "renderer"],
    ["notebooklm-text", "renderer"],
    ["notebooklm", "renderer"],
    ["telegram", "sink"],
  ] as const) {
    await db
      .insert(pluginSettings)
      .values({ pluginId, kind, enabled: true })
      .onConflictDoNothing();
  }

  const existing = await db
    .select()
    .from(topics)
    .where(eq(topics.slug, SEED.topic.slug));

  if (existing.length > 0) {
    console.log(
      JSON.stringify({ event: "seed-skipped", reason: "topic already exists" }),
    );
    return;
  }

  const [topic] = await db.insert(topics).values(SEED.topic).returning();

  for (const source of SEED.sources) {
    const [row] = await db
      .insert(sources)
      .values({
        pluginId: source.pluginId,
        label: source.label,
        config: source.config,
        enabled: source.enabled ?? true,
      })
      .returning();
    await db
      .insert(topicSources)
      .values({ topicId: topic!.id, sourceId: row!.id });
  }

  await db
    .insert(keywords)
    .values(SEED.keywords.map((k) => ({ topicId: topic!.id, ...k })));

  console.log(
    JSON.stringify({
      event: "seeded",
      topic: topic!.slug,
      sources: SEED.sources.length,
      keywords: SEED.keywords.length,
      note: "youtube-search is disabled until you add a Data API key",
    }),
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", error: String(error) }));
  process.exit(1);
});
