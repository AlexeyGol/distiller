import { z } from "zod";

/**
 * Zod schema -> form field descriptors.
 *
 * This is the one piece that makes "adding a plugin requires zero UI changes"
 * true. The UI never names a plugin field; it asks the plugin configSchema
 * what it wants and renders that. The same schema then validates the
 * submission on the server, so the form and the check cannot drift.
 *
 * Introspecting Zod internals is a deliberate trade: the alternative is a
 * parallel field-metadata declaration on every plugin, which is a second
 * source of truth that silently rots. Anything we cannot interpret degrades to
 * a raw JSON input rather than throwing, so an exotic schema costs the operator
 * convenience, never the ability to configure the plugin.
 */

export type FieldType =
  | "string"
  | "url"
  | "number"
  | "boolean"
  | "enum"
  | "unsupported";

export interface FormField {
  /** Key in the config object, and the form control name. */
  name: string;
  /** Humanised name for the label element. */
  label: string;
  type: FieldType;
  required: boolean;
  /** From .describe(), when the plugin author supplied one. */
  description?: string;
  /** Populated for `enum`. */
  options?: string[];
  defaultValue?: string | number | boolean;
  /** Only for `unsupported`: the Zod type name we could not render. */
  rawKind?: string;
}

/** Minimal slice of FormData, so callers can pass a plain object in tests. */
export interface FormDataLike {
  get(name: string): FormDataEntryValue | null;
}

const MAX_UNWRAP_DEPTH = 16;

/**
 * Describe every property of an object schema. A non-object schema (or
 * anything unrecognisable) yields an empty list: a plugin with no renderable
 * config is a valid state, not an error.
 */
export function describeSchema(schema: unknown): FormField[] {
  const root = unwrapAll(schema);
  if (!(root.inner instanceof z.ZodObject)) return [];

  const shape = root.inner.shape as Record<string, unknown>;
  return Object.keys(shape).map((name) => describeField(name, shape[name]));
}

function describeField(name: string, raw: unknown): FormField {
  const { inner, optional, defaultValue, description } = unwrapAll(raw);

  const base = {
    name,
    label: humanise(name),
    required: !optional,
    ...(description ? { description } : {}),
  };

  if (inner instanceof z.ZodString) {
    return {
      ...base,
      type: hasStringCheck(inner, "url") ? "url" : "string",
      ...defaultOf(defaultValue, "string"),
    };
  }

  if (inner instanceof z.ZodNumber) {
    return { ...base, type: "number", ...defaultOf(defaultValue, "number") };
  }

  if (inner instanceof z.ZodBoolean) {
    return { ...base, type: "boolean", ...defaultOf(defaultValue, "boolean") };
  }

  if (inner instanceof z.ZodEnum) {
    return {
      ...base,
      type: "enum",
      options: [...(inner.options as readonly string[])],
      ...defaultOf(defaultValue, "string"),
    };
  }

  if (inner instanceof z.ZodNativeEnum) {
    const values = Object.values(inner.enum as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
    return { ...base, type: "enum", options: values };
  }

  if (inner instanceof z.ZodLiteral && typeof inner.value === "string") {
    return {
      ...base,
      type: "enum",
      options: [inner.value],
      defaultValue: inner.value,
    };
  }

  // Arrays, records, unions, dates, nested objects: we cannot render a decent
  // control, so hand the operator a JSON box instead of failing the page.
  return { ...base, type: "unsupported", rawKind: kindOf(inner) };
}

function defaultOf(
  value: unknown,
  expected: "string" | "number" | "boolean",
): { defaultValue?: string | number | boolean } {
  if (typeof value === expected) {
    return { defaultValue: value as string | number | boolean };
  }
  return {};
}

interface Unwrapped {
  inner: unknown;
  optional: boolean;
  defaultValue?: unknown;
  description?: string;
}

/**
 * Peel the wrappers Zod stacks around a base type. `.optional()`, `.default()`
 * and `.catch()` all mean "the form may leave this blank"; effects and brands
 * are transparent to the UI.
 */
function unwrapAll(schema: unknown): Unwrapped {
  let current: unknown = schema;
  let optional = false;
  let defaultValue: unknown;
  let description: string | undefined;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (!isZodType(current)) break;

    description ??= current.description;

    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      optional = true;
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      defaultValue = safeDefault(current);
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodCatch) {
      optional = true;
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema;
      continue;
    }
    if (current instanceof z.ZodReadonly || current instanceof z.ZodBranded) {
      current = current.unwrap();
      continue;
    }
    break;
  }

  return { inner: current, optional, defaultValue, description };
}

function safeDefault(schema: z.ZodDefault<z.ZodTypeAny>): unknown {
  try {
    return schema._def.defaultValue();
  } catch {
    // A throwing default is the plugin problem, not a reason to blank the page.
    return undefined;
  }
}

function isZodType(value: unknown): value is z.ZodTypeAny {
  return value instanceof z.ZodType;
}

function hasStringCheck(schema: z.ZodString, kind: string): boolean {
  const checks = schema._def.checks as
    | ReadonlyArray<{ kind: string }>
    | undefined;
  return (checks ?? []).some((check) => check.kind === kind);
}

function kindOf(value: unknown): string {
  if (!isZodType(value)) return "unknown";
  const name = (value._def as { typeName?: string }).typeName;
  return name ?? value.constructor.name;
}

/** "apiKey" -> "Api key", "maxResults" -> "Max results". */
export function humanise(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Turn one submitted control into the value its schema expects.
 *
 * Blank optional fields become `undefined` (absent) rather than `""`, because
 * `z.string().url().optional()` rejects an empty string but accepts absence.
 * Malformed numbers are passed through as NaN on purpose: Zod produces a far
 * better error message than we would.
 */
export function coerceFieldValue(
  field: FormField,
  raw: FormDataEntryValue | null | undefined,
): unknown {
  if (field.type === "boolean") {
    return raw === "on" || raw === "true" || raw === "1";
  }

  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return field.required ? text : undefined;

  if (field.type === "number") return Number(text);

  if (field.type === "unsupported") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

/** Build a config object from a submitted form, driven by the field list. */
export function valuesFromFormData(
  fields: FormField[],
  form: FormDataLike,
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = coerceFieldValue(field, form.get(prefix + field.name));
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}

/**
 * Parse a submission against the schema that generated the form. Returns a
 * result rather than throwing so a page can re-render with the message.
 */
export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseConfig(schema: unknown, value: unknown): ParseResult {
  if (!isZodType(schema)) return { ok: true, value };
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: formatZodError(result.error) };
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
