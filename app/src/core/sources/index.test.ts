import { describe, expect, it } from "vitest";
import { sourcePlugins } from "./index.js";

/**
 * Smoke test for the sources barrel: the modules must load without touching
 * the network, and the ids must be unique or the registry throws at startup.
 */
describe("source barrel", () => {
  it("lists the sources cheapest and most general first", () => {
    // Order is what the "add a source" catalog shows: keyless feeds first,
    // the quota-metered API sources last.
    expect(sourcePlugins.map((p) => p.id)).toEqual([
      "rss",
      "reddit",
      "hackernews",
      "youtube-channel",
      "youtube-search",
    ]);
  });

  it("exports unique ids and source kinds only", () => {
    const ids = sourcePlugins.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sourcePlugins.every((p) => p.kind === "source")).toBe(true);
  });

  it("declares every source pollable with cursor support", () => {
    for (const plugin of sourcePlugins) {
      expect(plugin.capabilities).toEqual({
        pollable: true,
        supportsCursor: true,
      });
    }
  });
});
