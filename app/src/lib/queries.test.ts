import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../db/testing.js";
import { items, sources } from "../db/schema.js";
import { listSourceRuns } from "./queries.js";

/**
 * Regression coverage for the source list.
 *
 * itemCount was silently 0 for every source in the shipped UI. The query used
 * a correlated subquery, and Drizzle renders an interpolated column inside
 * sql`` without its table qualifier, so
 *     (select count(*) from items where source_id = id)
 * resolved both bare names against the inner table. Valid SQL, always false,
 * no error raised, nothing in 323 tests that looked at the number.
 *
 * The lesson these tests encode: a query that returns a plausible value is not
 * the same as a correct one, so assert the value against known data.
 */
describe("listSourceRuns", () => {
  let h: TestDb;

  beforeEach(async () => {
    h = await createTestDb();
  });

  afterEach(async () => {
    await h.close();
  });

  async function seedSource(label: string, itemCount: number) {
    const [source] = await h.db
      .insert(sources)
      .values({ pluginId: "rss", label, config: { url: "https://e.com/f" } })
      .returning();

    if (itemCount > 0) {
      await h.db.insert(items).values(
        Array.from({ length: itemCount }, (_, i) => ({
          sourceId: source!.id,
          externalId: `${label}-${i}`,
          url: `https://e.com/${label}/${i}`,
          title: `Item ${i}`,
          publishedAt: new Date(),
        })),
      );
    }
    return source!;
  }

  it("counts each source's own items, not zero and not the global total", async () => {
    await seedSource("alpha", 3);
    await seedSource("beta", 5);

    const runs = await listSourceRuns(h.db);
    const byLabel = Object.fromEntries(runs.map((r) => [r.label, r.itemCount]));

    expect(byLabel.alpha).toBe(3);
    expect(byLabel.beta).toBe(5);
  });

  it("reports 0 for a source with no items without dropping the row", async () => {
    // A LEFT JOIN is required here: an INNER JOIN would make an unpolled
    // source vanish from the page entirely.
    await seedSource("empty", 0);
    await seedSource("full", 2);

    const runs = await listSourceRuns(h.db);

    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.label === "empty")!.itemCount).toBe(0);
  });

  it("returns a number, not a string, so the UI can do arithmetic", async () => {
    await seedSource("alpha", 1);
    const [run] = await listSourceRuns(h.db);
    expect(typeof run!.itemCount).toBe("number");
  });

  it("carries the stored config so the page can show and edit the query", async () => {
    const [source] = await h.db
      .insert(sources)
      .values({
        pluginId: "youtube-search",
        label: "yt",
        config: { query: "AI agents", maxResults: 25 },
      })
      .returning();

    const runs = await listSourceRuns(h.db);
    const run = runs.find((r) => r.id === source!.id)!;

    expect(run.config).toEqual({ query: "AI agents", maxResults: 25 });
  });

  it("orders by label so the list is stable between renders", async () => {
    await seedSource("zulu", 1);
    await seedSource("alpha", 1);

    const labels = (await listSourceRuns(h.db)).map((r) => r.label);
    expect(labels).toEqual(["alpha", "zulu"]);
  });

  it("keeps counts independent when two sources share an externalId", async () => {
    // externalId is only unique per source, so the join must not conflate them.
    const a = await seedSource("a", 0);
    const b = await seedSource("b", 0);
    for (const source of [a, b]) {
      await h.db.insert(items).values({
        sourceId: source.id,
        externalId: "shared",
        url: "https://e.com/x",
        title: "Shared",
        publishedAt: new Date(),
      });
    }

    const runs = await listSourceRuns(h.db);
    expect(runs.map((r) => r.itemCount)).toEqual([1, 1]);
  });
});
