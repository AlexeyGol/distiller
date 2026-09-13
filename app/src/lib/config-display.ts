/**
 * Rendering a plugin config for human eyes.
 *
 * Two jobs, and the second is the important one:
 *   1. show what a source actually asks for (the feed URL, the search query)
 *   2. never print a credential into a page, a log or a screenshot
 *
 * Source configs legitimately hold secrets - a YouTube Data API key, a bot
 * token - because that is where per-instance config belongs. So masking is
 * applied on the way OUT, by field name, defaulting to masked for anything
 * that looks credential-shaped.
 */

import { isEnvRef } from "./env-ref.js";

/** Word stems whose presence in a field name means "do not print this". */
const SECRET_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "auth",
]);

/**
 * Split a field name into lowercase words across camelCase, snake_case,
 * kebab-case and dots.
 *
 * The camelCase split is the part that matters. An earlier version matched only
 * on separator boundaries, so "api_key" was caught but "botToken" - the actual
 * field name on the Telegram sink - was not, and the bot token would have been
 * rendered in full. Field names in this codebase are camelCase by convention,
 * which made that the common case rather than the rare one.
 */
function fieldWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function isSecretField(name: string): boolean {
  const words = fieldWords(name);
  return (
    words.some((word) => SECRET_WORDS.has(word)) ||
    SECRET_WORDS.has(words.join(""))
  );
}

/**
 * Mask a secret while leaving enough to recognise it. An empty value renders
 * as "not set" rather than a row of dots, because "unset" and "hidden" mean
 * very different things when you are debugging why a source fails.
 */
export function maskSecret(value: string): string {
  if (value === "") return "not set";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-2)}`;
}

export interface ConfigEntry {
  key: string;
  /** Display-safe. Already masked when the field is a secret. */
  value: string;
  secret: boolean;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return value === "" ? "not set" : value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * Flatten a stored config into display rows, masking anything credential-like.
 * Key order follows the object so a plugin's own field order is preserved.
 */
export function configEntries(config: unknown): ConfigEntry[] {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }

  return Object.entries(config as Record<string, unknown>).map(
    ([key, raw]) => {
      const shown = displayValue(raw);

      // An environment reference is not a credential, it is the NAME of one.
      // Masking it would hide the single most useful thing on the page: which
      // variable this source actually needs.
      if (isEnvRef(raw)) {
        return { key, value: shown, secret: false };
      }

      const secret = isSecretField(key);
      return {
        key,
        value: secret && shown !== "not set" ? maskSecret(String(raw)) : shown,
        secret,
      };
    },
  );
}

/**
 * One-line summary for a table cell, e.g.
 *   url: https://simonwillison.net/atom/everything/
 *   query: AI agents, maxResults: 25, apiKey: AIza...7b
 */
export function summariseConfig(config: unknown, maxLength = 90): string {
  const entries = configEntries(config);
  if (entries.length === 0) return "-";

  const joined = entries.map((e) => `${e.key}: ${e.value}`).join(", ");
  // The ellipsis counts toward maxLength, so a caller sizing a table cell gets
  // the width it actually asked for.
  return joined.length <= maxLength
    ? joined
    : `${joined.slice(0, maxLength - 3)}...`;
}
