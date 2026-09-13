import { describe, expect, it } from "vitest";
import { applyEnv, loadEnv, parseEnvFile } from "./env.js";

/**
 * The env loader is load-bearing for every entry point Next.js does not start:
 * worker, migrate, seed, poll. Before it existed they silently saw no
 * DATABASE_URL and fell back to a default, which is the worst kind of failure -
 * the worker connects happily to the wrong database and reports success.
 */

describe("parseEnvFile", () => {
  it("parses plain assignments", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseEnvFile("# a comment\n\nA=1\n   \n#B=2\n");
    expect(parsed).toEqual({ A: "1" });
  });

  it("keeps '=' inside a value, which connection strings contain", () => {
    const parsed = parseEnvFile("DATABASE_URL=postgres://u:p@h/db?a=b&c=d");
    expect(parsed.DATABASE_URL).toBe("postgres://u:p@h/db?a=b&c=d");
  });

  it("strips one pair of surrounding quotes", () => {
    expect(parseEnvFile(`A="quoted"\nB='single'`)).toEqual({
      A: "quoted",
      B: "single",
    });
  });

  it("keeps '#' inside a quoted value", () => {
    // Passwords and tokens legitimately contain '#'. Treating it as a comment
    // would truncate a credential and produce a baffling auth failure.
    expect(parseEnvFile(`P="pa#ss"`).P).toBe("pa#ss");
  });

  it("strips a trailing comment only when clearly separated", () => {
    expect(parseEnvFile("A=value # trailing").A).toBe("value");
    // No space before '#': part of the value, as in a token.
    expect(parseEnvFile("A=val#ue").A).toBe("val#ue");
  });

  it("trims surrounding whitespace on keys and values", () => {
    expect(parseEnvFile("  A  =  1  ")).toEqual({ A: "1" });
  });

  it("accepts an empty value", () => {
    expect(parseEnvFile("A=")).toEqual({ A: "" });
  });

  it("skips malformed lines rather than throwing", () => {
    expect(parseEnvFile("no-equals-here\nA=1")).toEqual({ A: "1" });
    expect(parseEnvFile("=novalue\nA=1")).toEqual({ A: "1" });
  });

  it("handles an empty file", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});

describe("applyEnv", () => {
  it("sets values that are absent", () => {
    const target: Record<string, string | undefined> = {};
    expect(applyEnv({ A: "1" }, target)).toEqual(["A"]);
    expect(target.A).toBe("1");
  });

  it("NEVER overwrites an existing variable", () => {
    // This is what lets the same entry point work in Docker, where compose sets
    // the environment directly and the file does not exist.
    const target: Record<string, string | undefined> = { A: "from-shell" };
    expect(applyEnv({ A: "from-file" }, target)).toEqual([]);
    expect(target.A).toBe("from-shell");
  });

  it("applies only the missing subset", () => {
    const target: Record<string, string | undefined> = { A: "kept" };
    expect(applyEnv({ A: "ignored", B: "set" }, target)).toEqual(["B"]);
    expect(target).toEqual({ A: "kept", B: "set" });
  });

  it("treats an empty string as set, not as absent", () => {
    const target: Record<string, string | undefined> = { A: "" };
    expect(applyEnv({ A: "file" }, target)).toEqual([]);
    expect(target.A).toBe("");
  });
});

describe("loadEnv", () => {
  it("is a silent no-op when no env file exists", () => {
    // The Docker case: no file in the image, environment already populated.
    expect(() => loadEnv("/nonexistent-directory-for-this-test")).not.toThrow();
    expect(loadEnv("/nonexistent-directory-for-this-test")).toEqual([]);
  });
});
