import type { KeywordRule, NormalizedItem } from "./types.js";

/**
 * Keyword matching for topic filtering.
 *
 * Rules, evaluated against the item's title + body:
 *   1. Any matching `exclude` term rejects the item outright (exclude wins).
 *   2. If there is at least one `include` term, one of them must match.
 *   3. If there are no `include` terms, everything not excluded passes.
 *
 * Terms match on word boundaries and case-insensitively, so "AI" matches
 * "AI safety" and "generative ai" but not "said" or "chain". Multi-word terms
 * are matched as phrases with flexible interior whitespace.
 */

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(literal: string): string {
  return literal.replace(REGEX_METACHARS, "\\$&");
}

/**
 * Word boundaries only apply where the term actually starts/ends with a word
 * character. A term like "c++" must not demand a trailing \b, which could
 * never match after "+".
 */
function buildTermPattern(term: string): RegExp | null {
  const trimmed = term.trim();
  if (trimmed === "") return null;

  // Collapse interior whitespace into a flexible separator so "open  ai"
  // and "open ai" behave identically.
  const body = trimmed
    .split(/\s+/)
    .map((part) => escapeRegex(part))
    .join("\\s+");

  const leading = /^\w/.test(trimmed) ? "\\b" : "";
  const trailing = /\w$/.test(trimmed) ? "\\b" : "";

  return new RegExp(`${leading}${body}${trailing}`, "i");
}

/** The text a keyword rule is evaluated against. */
export function searchableText(item: NormalizedItem): string {
  return item.body ? `${item.title}\n${item.body}` : item.title;
}

export function termMatches(term: string, text: string): boolean {
  const pattern = buildTermPattern(term);
  if (pattern === null) return false;
  return pattern.test(text);
}

export interface MatchExplanation {
  matched: boolean;
  /** The exclude term that rejected the item, when one did. */
  excludedBy?: string;
  /** The include terms that matched. Empty when the topic has no include rules. */
  matchedTerms: string[];
}

/**
 * Evaluate one item against a topic's keyword rules, returning why it matched.
 * The explanation is surfaced in the curation UI so a draft is reviewable.
 */
export function explainMatch(
  item: NormalizedItem,
  rules: readonly KeywordRule[],
): MatchExplanation {
  const text = searchableText(item);

  const excludes = rules.filter((r) => r.mode === "exclude");
  for (const rule of excludes) {
    if (termMatches(rule.term, text)) {
      return { matched: false, excludedBy: rule.term, matchedTerms: [] };
    }
  }

  const includes = rules.filter((r) => r.mode === "include");
  if (includes.length === 0) {
    return { matched: true, matchedTerms: [] };
  }

  const matchedTerms = includes
    .filter((rule) => termMatches(rule.term, text))
    .map((rule) => rule.term);

  return { matched: matchedTerms.length > 0, matchedTerms };
}

export function matchesTopic(
  item: NormalizedItem,
  rules: readonly KeywordRule[],
): boolean {
  return explainMatch(item, rules).matched;
}

export function filterItems<T extends NormalizedItem>(
  items: readonly T[],
  rules: readonly KeywordRule[],
): T[] {
  return items.filter((item) => matchesTopic(item, rules));
}
