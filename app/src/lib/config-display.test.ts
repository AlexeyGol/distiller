import { describe, expect, it } from "vitest";
import {
  configEntries,
  isSecretField,
  maskSecret,
  summariseConfig,
} from "./config-display.js";

describe("isSecretField", () => {
  it("recognises the credential field names plugins actually use", () => {
    for (const name of [
      "apiKey",
      "api_key",
      "botToken",
      "token",
      "secret",
      "password",
      "clientSecret",
      "authToken",
    ]) {
      expect(isSecretField(name), name).toBe(true);
    }
  });

  it("leaves ordinary config fields alone", () => {
    for (const name of [
      "url",
      "query",
      "channelId",
      "maxResults",
      "regionCode",
      "baseUrl",
      "chatId",
      "model",
      "provider",
    ]) {
      expect(isSecretField(name), name).toBe(false);
    }
  });
});

describe("maskSecret", () => {
  it("keeps a recognisable prefix and suffix", () => {
    expect(maskSecret("AIzaSyD-1234567890abcdefXY")).toBe("AIza...XY");
  });

  it("fully masks a short value rather than revealing most of it", () => {
    expect(maskSecret("abc123")).toBe("********");
  });

  it("distinguishes unset from hidden", () => {
    // These mean very different things when debugging a failing source.
    expect(maskSecret("")).toBe("not set");
  });
});

describe("configEntries", () => {
  it("masks secrets and shows everything else in full", () => {
    const entries = configEntries({
      query: "AI agents",
      maxResults: 25,
      apiKey: "AIzaSyD-1234567890abcdefXY",
    });

    expect(entries).toEqual([
      { key: "query", value: "AI agents", secret: false },
      { key: "maxResults", value: "25", secret: false },
      { key: "apiKey", value: "AIza...XY", secret: true },
    ]);
  });

  it("never leaks a full credential", () => {
    const secret = "super-secret-token-value-12345";
    const entries = configEntries({ botToken: secret });
    expect(entries[0]!.value).not.toContain("secret-token");
    expect(entries[0]!.secret).toBe(true);
  });

  it("renders booleans and missing values readably", () => {
    expect(configEntries({ a: true, b: false, c: null, d: "" })).toEqual([
      { key: "a", value: "yes", secret: false },
      { key: "b", value: "no", secret: false },
      { key: "c", value: "not set", secret: false },
      { key: "d", value: "not set", secret: false },
    ]);
  });

  it("shows an unset secret as unset, not as a mask", () => {
    expect(configEntries({ apiKey: "" })).toEqual([
      { key: "apiKey", value: "not set", secret: true },
    ]);
  });

  it("preserves the plugin's own field order", () => {
    const keys = configEntries({ z: 1, a: 2, m: 3 }).map((e) => e.key);
    expect(keys).toEqual(["z", "a", "m"]);
  });

  it("returns nothing for a non-object config", () => {
    expect(configEntries(null)).toEqual([]);
    expect(configEntries("nope")).toEqual([]);
    expect(configEntries([1, 2])).toEqual([]);
  });
});

describe("summariseConfig", () => {
  it("gives a readable one-liner for a feed", () => {
    expect(summariseConfig({ url: "https://example.com/feed.xml" })).toBe(
      "url: https://example.com/feed.xml",
    );
  });

  it("keeps the query visible for a youtube search", () => {
    const summary = summariseConfig({
      query: "AI agents",
      maxResults: 25,
      apiKey: "AIzaSyD-1234567890abcdefXY",
    });
    expect(summary).toContain("query: AI agents");
    expect(summary).not.toContain("1234567890");
  });

  it("truncates rather than blowing out a table cell", () => {
    const summary = summariseConfig({ url: "https://e.com/" + "x".repeat(200) });
    expect(summary.length).toBeLessThanOrEqual(90);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("returns a dash for an empty config", () => {
    expect(summariseConfig({})).toBe("-");
  });
});
