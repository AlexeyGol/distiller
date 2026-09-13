import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  coerceFieldValue,
  describeSchema,
  humanise,
  parseConfig,
  valuesFromFormData,
  type FormField,
} from "./schema-form.js";
import { rssConfigSchema } from "../core/sources/rss.js";
import { llmTextConfigSchema } from "../renderers/llm-text.js";
import { telegramConfigSchema } from "../sinks/telegram.js";

function field(fields: FormField[], name: string): FormField {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field named ${name}: ${fields.map((f) => f.name)}`);
  return found;
}

/** A FormData stand-in, so these tests need no DOM. */
function form(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null };
}

describe("describeSchema", () => {
  it("maps every supported primitive to a field type", () => {
    const fields = describeSchema(
      z.object({
        title: z.string(),
        homepage: z.string().url(),
        count: z.number(),
        active: z.boolean(),
        provider: z.enum(["gemini", "anthropic"]),
      }),
    );

    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ["title", "string"],
      ["homepage", "url"],
      ["count", "number"],
      ["active", "boolean"],
      ["provider", "enum"],
    ]);
    expect(field(fields, "provider").options).toEqual(["gemini", "anthropic"]);
  });

  it("marks required vs optional, seeing through optional/default/nullable", () => {
    const fields = describeSchema(
      z.object({
        needed: z.string(),
        maybe: z.string().optional(),
        nullable: z.string().nullable(),
        withDefault: z.string().default("hello"),
        numberDefault: z.number().default(7),
      }),
    );

    expect(field(fields, "needed").required).toBe(true);
    expect(field(fields, "maybe").required).toBe(false);
    expect(field(fields, "nullable").required).toBe(false);
    expect(field(fields, "withDefault").required).toBe(false);
    expect(field(fields, "withDefault").defaultValue).toBe("hello");
    expect(field(fields, "numberDefault").defaultValue).toBe(7);
  });

  it("keeps the url format through optional wrappers", () => {
    const fields = describeSchema(z.object({ base: z.string().url().optional() }));
    expect(field(fields, "base").type).toBe("url");
    expect(field(fields, "base").required).toBe(false);
  });

  it("carries .describe() text through to the field", () => {
    const fields = describeSchema(
      z.object({ apiKey: z.string().describe("From the Google console") }),
    );
    expect(field(fields, "apiKey").description).toBe("From the Google console");
  });

  it("sees through effects and refinements", () => {
    const fields = describeSchema(
      z.object({ term: z.string().trim().min(1).refine((v) => v !== "no") }),
    );
    expect(field(fields, "term").type).toBe("string");
  });

  it("degrades unsupported types gracefully instead of throwing", () => {
    const fields = describeSchema(
      z.object({
        when: z.date(),
        tags: z.array(z.string()),
        nested: z.object({ a: z.string() }),
        either: z.union([z.string(), z.number()]),
        bag: z.record(z.string()),
      }),
    );

    for (const name of ["when", "tags", "nested", "either", "bag"]) {
      expect(field(fields, name).type).toBe("unsupported");
      expect(field(fields, name).rawKind).toBeTruthy();
    }
  });

  it("returns an empty list for a non-object schema rather than throwing", () => {
    expect(describeSchema(z.string())).toEqual([]);
    expect(describeSchema(undefined)).toEqual([]);
    expect(describeSchema({ not: "a schema" })).toEqual([]);
    expect(describeSchema(null)).toEqual([]);
  });

  it("humanises names for labels", () => {
    expect(humanise("apiKey")).toBe("Api key");
    expect(humanise("maxResults")).toBe("Max results");
    expect(humanise("send_audio_as_document")).toBe("Send audio as document");
  });
});

describe("describeSchema against the real plugin schemas", () => {
  it("renders the rss source without the UI knowing its fields", () => {
    const fields = describeSchema(rssConfigSchema);
    expect(field(fields, "url").type).toBe("url");
    expect(field(fields, "url").required).toBe(true);
    expect(field(fields, "userAgent").required).toBe(false);
  });

  it("renders the llm-text renderer enum", () => {
    const fields = describeSchema(llmTextConfigSchema);
    expect(field(fields, "provider").type).toBe("enum");
    expect(field(fields, "provider").options).toContain("ollama");
    expect(field(fields, "baseUrl").type).toBe("url");
  });

  it("renders the telegram sink boolean", () => {
    const fields = describeSchema(telegramConfigSchema);
    expect(field(fields, "sendAudioAsDocument").type).toBe("boolean");
    expect(field(fields, "botToken").required).toBe(true);
  });
});

describe("coerceFieldValue", () => {
  const str: FormField = { name: "a", label: "A", type: "string", required: true };
  const optStr: FormField = { ...str, required: false };
  const num: FormField = { name: "n", label: "N", type: "number", required: false };
  const bool: FormField = { name: "b", label: "B", type: "boolean", required: false };
  const json: FormField = {
    name: "j",
    label: "J",
    type: "unsupported",
    required: false,
  };

  it("drops blank optional fields so optional().url() still validates", () => {
    expect(coerceFieldValue(optStr, "")).toBeUndefined();
    expect(coerceFieldValue(optStr, null)).toBeUndefined();
  });

  it("keeps a blank required field so Zod can report it", () => {
    expect(coerceFieldValue(str, "")).toBe("");
  });

  it("converts numbers and leaves malformed input as NaN for Zod", () => {
    expect(coerceFieldValue(num, "12")).toBe(12);
    expect(Number.isNaN(coerceFieldValue(num, "abc") as number)).toBe(true);
  });

  it("treats an absent checkbox as false", () => {
    expect(coerceFieldValue(bool, "on")).toBe(true);
    expect(coerceFieldValue(bool, null)).toBe(false);
  });

  it("parses JSON for unsupported fields, falling back to the raw text", () => {
    expect(coerceFieldValue(json, '["a","b"]')).toEqual(["a", "b"]);
    expect(coerceFieldValue(json, "not json")).toBe("not json");
  });
});

describe("valuesFromFormData + parseConfig round trip", () => {
  it("builds a config the plugin schema accepts", () => {
    const fields = describeSchema(rssConfigSchema);
    const values = valuesFromFormData(
      fields,
      form({ url: "https://example.com/feed.xml", userAgent: "" }),
    );

    expect(values).toEqual({ url: "https://example.com/feed.xml" });
    expect(parseConfig(rssConfigSchema, values)).toEqual({
      ok: true,
      value: { url: "https://example.com/feed.xml" },
    });
  });

  it("reports a readable error instead of throwing", () => {
    const fields = describeSchema(rssConfigSchema);
    const values = valuesFromFormData(fields, form({ url: "not-a-url" }));
    const result = parseConfig(rssConfigSchema, values);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("url");
  });

  it("honours a field name prefix", () => {
    const fields = describeSchema(rssConfigSchema);
    const values = valuesFromFormData(
      fields,
      form({ "cfg.url": "https://example.com/f" }),
      "cfg.",
    );
    expect(values).toEqual({ url: "https://example.com/f" });
  });
});
