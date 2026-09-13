import { describe, expect, it } from "vitest";
import {
  explainMatch,
  filterItems,
  matchesTopic,
  searchableText,
  termMatches,
} from "./filter.js";
import type { KeywordRule, NormalizedItem } from "./types.js";

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: "id-1",
    url: "https://example.com/1",
    title: "A post about things",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    raw: {},
    ...overrides,
  };
}

const include = (term: string): KeywordRule => ({ term, mode: "include" });
const exclude = (term: string): KeywordRule => ({ term, mode: "exclude" });

describe("termMatches", () => {
  it("matches case-insensitively", () => {
    expect(termMatches("kubernetes", "Kubernetes 1.31 released")).toBe(true);
    expect(termMatches("KUBERNETES", "kubernetes rocks")).toBe(true);
  });

  it("respects word boundaries so short terms do not match inside words", () => {
    // The whole reason for boundary matching: "AI" must not match "said".
    expect(termMatches("AI", "She said hello")).toBe(false);
    expect(termMatches("AI", "chain of thought")).toBe(false);
    expect(termMatches("AI", "AI safety research")).toBe(true);
    expect(termMatches("ai", "generative ai is here")).toBe(true);
  });

  it("matches a term at the very start and very end of the text", () => {
    expect(termMatches("rust", "rust is fast")).toBe(true);
    expect(termMatches("fast", "rust is fast")).toBe(true);
  });

  it("treats multi-word terms as phrases with flexible whitespace", () => {
    expect(termMatches("open ai", "OpenAI")).toBe(false);
    expect(termMatches("open ai", "open ai announced")).toBe(true);
    expect(termMatches("open  ai", "open ai announced")).toBe(true);
    expect(termMatches("open ai", "open\nai announced")).toBe(true);
  });

  it("does not treat terms as regular expressions", () => {
    // A naive implementation would explode or match everything here.
    expect(termMatches("c++", "I write c++ daily")).toBe(true);
    expect(termMatches("a.b", "axb")).toBe(false);
    expect(termMatches("a.b", "a.b")).toBe(true);
    expect(() => termMatches("(unclosed", "text")).not.toThrow();
    expect(termMatches("(unclosed", "an (unclosed thing")).toBe(true);
  });

  it("handles terms that do not start or end with word characters", () => {
    expect(termMatches("c++", "c++")).toBe(true);
    expect(termMatches(".net", "using .net here")).toBe(true);
  });

  it("ignores empty and whitespace-only terms", () => {
    expect(termMatches("", "anything")).toBe(false);
    expect(termMatches("   ", "anything")).toBe(false);
  });
});

describe("searchableText", () => {
  it("includes the body when present", () => {
    const text = searchableText(item({ title: "T", body: "B" }));
    expect(text).toContain("T");
    expect(text).toContain("B");
  });

  it("falls back to just the title when there is no body", () => {
    expect(searchableText(item({ title: "T", body: undefined }))).toBe("T");
  });
});

describe("explainMatch", () => {
  it("passes everything when there are no rules at all", () => {
    const result = explainMatch(item(), []);
    expect(result.matched).toBe(true);
    expect(result.matchedTerms).toEqual([]);
  });

  it("passes everything not excluded when there are only exclude rules", () => {
    const rules = [exclude("sponsored")];
    expect(explainMatch(item({ title: "Real news" }), rules).matched).toBe(true);
    expect(explainMatch(item({ title: "Sponsored post" }), rules).matched).toBe(
      false,
    );
  });

  it("requires at least one include term to match when includes exist", () => {
    const rules = [include("kubernetes"), include("docker")];
    expect(explainMatch(item({ title: "Docker news" }), rules).matched).toBe(
      true,
    );
    expect(explainMatch(item({ title: "Gardening tips" }), rules).matched).toBe(
      false,
    );
  });

  it("lets exclude win over a matching include", () => {
    // This is the rule that makes a topic controllable: one exclude term can
    // veto an otherwise-matching item.
    const rules = [include("kubernetes"), exclude("sponsored")];
    const result = explainMatch(
      item({ title: "Kubernetes tips", body: "This is a sponsored post" }),
      rules,
    );
    expect(result.matched).toBe(false);
    expect(result.excludedBy).toBe("sponsored");
  });

  it("reports which include terms matched, for the curation UI", () => {
    const rules = [include("rust"), include("go"), include("zig")];
    const result = explainMatch(
      item({ title: "Rust and Go interop", body: "" }),
      rules,
    );
    expect(result.matched).toBe(true);
    expect(result.matchedTerms.sort()).toEqual(["go", "rust"]);
  });

  it("names the excluding term and reports no matched terms", () => {
    const result = explainMatch(item({ title: "Sponsored" }), [
      exclude("sponsored"),
    ]);
    expect(result.excludedBy).toBe("sponsored");
    expect(result.matchedTerms).toEqual([]);
  });

  it("matches against the body, not only the title", () => {
    const rules = [include("postgres")];
    const result = explainMatch(
      item({ title: "Database notes", body: "We migrated to postgres" }),
      rules,
    );
    expect(result.matched).toBe(true);
  });
});

describe("matchesTopic / filterItems", () => {
  it("matchesTopic agrees with explainMatch", () => {
    const rules = [include("rust")];
    expect(matchesTopic(item({ title: "rust" }), rules)).toBe(true);
    expect(matchesTopic(item({ title: "python" }), rules)).toBe(false);
  });

  it("filters a list and preserves order", () => {
    const items = [
      item({ externalId: "a", title: "rust release" }),
      item({ externalId: "b", title: "gardening" }),
      item({ externalId: "c", title: "rust tooling" }),
    ];
    const kept = filterItems(items, [include("rust")]);
    expect(kept.map((i) => i.externalId)).toEqual(["a", "c"]);
  });

  it("returns an empty array rather than throwing on empty input", () => {
    expect(filterItems([], [include("rust")])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const items = [item({ externalId: "a", title: "rust" })];
    const copy = [...items];
    filterItems(items, [include("nothing")]);
    expect(items).toEqual(copy);
  });
});
