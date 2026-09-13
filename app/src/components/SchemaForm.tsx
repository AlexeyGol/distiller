import type { FormField } from "../lib/schema-form.js";

/**
 * Renders a config form from field descriptors derived from a plugin Zod
 * schema. It knows about field *types*, never about field names: that is what
 * makes a new plugin cost zero UI changes.
 */

export interface SchemaFormProps {
  fields: FormField[];
  /** Prefix so a config form can share a <form> with other inputs. */
  prefix?: string;
  /** Existing config, for the edit case. */
  values?: Record<string, unknown>;
  idPrefix?: string;
}

export function SchemaForm({
  fields,
  prefix = "config.",
  values,
  idPrefix = "f",
}: SchemaFormProps) {
  if (fields.length === 0) {
    return <p className="muted">This plugin needs no configuration.</p>;
  }

  return (
    <div className="fields">
      {fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          name={prefix + field.name}
          id={`${idPrefix}-${prefix}${field.name}`}
          value={values?.[field.name]}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  field: FormField;
  name: string;
  id: string;
  value: unknown;
}

function Field({ field, name, id, value }: FieldProps) {
  const initial = value ?? field.defaultValue;

  return (
    <div className="field">
      <label htmlFor={id}>
        {field.label}
        {field.required ? <span className="req"> *</span> : null}
      </label>
      <Control field={field} name={name} id={id} initial={initial} />
      {field.description ? (
        <p className="hint">{field.description}</p>
      ) : null}
      {field.type === "unsupported" ? (
        <p className="hint">
          No control for {field.rawKind ?? "this type"}; enter JSON.
        </p>
      ) : null}
    </div>
  );
}

function Control({
  field,
  name,
  id,
  initial,
}: {
  field: FormField;
  name: string;
  id: string;
  initial: unknown;
}) {
  switch (field.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          id={id}
          name={name}
          defaultChecked={initial === true}
        />
      );

    case "enum":
      return (
        <select
          id={id}
          name={name}
          defaultValue={asText(initial)}
          required={field.required}
        >
          {!field.required ? <option value="">(not set)</option> : null}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    case "number":
      return (
        <input
          type="number"
          id={id}
          name={name}
          defaultValue={asText(initial)}
          required={field.required}
          step="any"
        />
      );

    case "url":
      return (
        <input
          type="url"
          id={id}
          name={name}
          defaultValue={asText(initial)}
          required={field.required}
          placeholder="https://"
        />
      );

    case "unsupported":
      return (
        <textarea
          id={id}
          name={name}
          rows={3}
          defaultValue={initial === undefined ? "" : JSON.stringify(initial)}
          required={field.required}
        />
      );

    default:
      return (
        <input
          type="text"
          id={id}
          name={name}
          defaultValue={asText(initial)}
          required={field.required}
        />
      );
  }
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
