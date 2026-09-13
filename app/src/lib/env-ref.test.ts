import { describe, expect, it } from "vitest";
import {
  MissingEnvError,
  isEnvRef,
  parseEnvRef,
  referencedVariables,
  resolveEnvRefs,
} from "./env-ref.js";
import { configEntries } from "./config-display.js";
import { redactConfig, REDACTED } from "./config-transfer.js";

describe("parseEnvRef", () => {
  it("recognises a whole-value reference", () => {
    expect(parseEnvRef("${YOUTUBE_API_KEY}")).toEqual({
      name: "YOUTUBE_API_KEY",
      fallback: undefined,
    });
  });

  it("supports a fallback", () => {
    expect(parseEnvRef("${OLLAMA_URL:-http://localhost:11434}")).toEqual({
      name: "OLLAMA_URL",
      fallback: "http://localhost:11434",
    });
  });

  it("only matches a WHOLE value, never a substring", () => {
    // A partial substitution would make a password containing "${" behave
    // surprisingly, and a reference should always be visibly a reference.
    expect(parseEnvRef("prefix ${VAR}")).toBeNull();
    expect(parseEnvRef("${VAR} suffix")).toBeNull();
    expect(parseEnvRef("${A}${B}")).toBeNull();
  });

  it("rejects shapes that are not references", () => {
    for (const value of ["", "plain", "$VAR", "{VAR}", "${}", "${1BAD}", 42, null]) {
      expect(isEnvRef(value), String(value)).toBe(false);
    }
  });
});

describe("resolveEnvRefs", () => {
  const env = { YOUTUBE_API_KEY: "AIza-real", EMPTY: "" };

  it("substitutes the environment value", () => {
    expect(
      resolveEnvRefs({ query: "AI", apiKey: "${YOUTUBE_API_KEY}" }, env),
    ).toEqual({ query: "AI", apiKey: "AIza-real" });
  });

  it("leaves literals untouched, so pasting a key still works", () => {
    expect(resolveEnvRefs({ apiKey: "literal-key" }, env)).toEqual({
      apiKey: "literal-key",
    });
  });

  it("THROWS on a missing variable rather than substituting empty", () => {
    // An empty API key produces a 403 far from its cause. Naming the variable
    // and the field here is the difference between a two-minute fix and an
    // afternoon.
    expect(() => resolveEnvRefs({ apiKey: "${NOPE}" }, env)).toThrow(
      MissingEnvError,
    );

    try {
      resolveEnvRefs({ apiKey: "${NOPE}" }, env);
    } catch (error) {
      expect((error as Error).message).toContain("$NOPE");
      expect((error as Error).message).toContain("apiKey");
    }
  });

  it("treats an empty environment variable as missing", () => {
    expect(() => resolveEnvRefs({ apiKey: "${EMPTY}" }, env)).toThrow(
      MissingEnvError,
    );
  });

  it("uses the fallback when the variable is unset", () => {
    expect(resolveEnvRefs({ baseUrl: "${NOPE:-http://x}" }, env)).toEqual({
      baseUrl: "http://x",
    });
  });

  it("prefers the real variable over the fallback", () => {
    expect(
      resolveEnvRefs({ apiKey: "${YOUTUBE_API_KEY:-fallback}" }, env),
    ).toEqual({ apiKey: "AIza-real" });
  });

  it("passes non-object configs through", () => {
    expect(resolveEnvRefs(null, env)).toBeNull();
    expect(resolveEnvRefs("x", env)).toBe("x");
  });

  it("leaves non-string values alone", () => {
    expect(resolveEnvRefs({ maxResults: 25, enabled: true }, env)).toEqual({
      maxResults: 25,
      enabled: true,
    });
  });
});

describe("referencedVariables", () => {
  it("lists what a config needs from the environment", () => {
    expect(
      referencedVariables({
        a: "${ONE}",
        b: "literal",
        c: "${TWO:-x}",
        d: "${ONE}",
      }),
    ).toEqual(["ONE", "TWO"]);
  });

  it("returns nothing for a config of literals", () => {
    expect(referencedVariables({ url: "https://e.com" })).toEqual([]);
  });
});

describe("a reference is not a secret", () => {
  it("is NOT masked in the UI", () => {
    // The variable name is the single most useful thing on the page: it tells
    // the operator exactly what this source needs.
    const [entry] = configEntries({ apiKey: "${YOUTUBE_API_KEY}" });
    expect(entry!.value).toBe("${YOUTUBE_API_KEY}");
    expect(entry!.secret).toBe(false);
  });

  it("is NOT redacted on export", () => {
    expect(redactConfig({ apiKey: "${YOUTUBE_API_KEY}" })).toEqual({
      apiKey: "${YOUTUBE_API_KEY}",
    });
  });

  it("still masks and redacts a literal in the same field", () => {
    expect(configEntries({ apiKey: "AIzaLITERALVALUE" })[0]!.secret).toBe(true);
    expect(redactConfig({ apiKey: "AIzaLITERALVALUE" }).apiKey).toBe(REDACTED);
  });

  it("means a reference-based config exports in full and imports unchanged", () => {
    // The property that makes this worth having: nothing is lost on export, so
    // the bundle round-trips without a --with-secrets variant at all.
    const config = { query: "AI", apiKey: "${YOUTUBE_API_KEY}", maxResults: 25 };
    expect(redactConfig(config)).toEqual(config);
  });
});
