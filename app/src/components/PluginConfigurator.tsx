"use client";

import { useActionState, useState } from "react";
import { SchemaForm } from "./SchemaForm.js";
import { EMPTY_STATE } from "../lib/action-state.js";
import type { PluginCatalogEntry } from "../lib/catalog.js";
import type { FormAction } from "./ActionForm.js";

export interface PluginConfiguratorProps {
  catalog: PluginCatalogEntry[];
  createAction: FormAction;
  testAction: FormAction;
  createLabel: string;
  noun: string;
}

/**
 * Pick a plugin type, then fill in the form that plugin describes.
 *
 * The catalog (including the field descriptors) is computed on the server from
 * each plugin configSchema, so this component contains no knowledge of any
 * particular plugin. Adding a new one changes nothing here.
 */
export function PluginConfigurator({
  catalog,
  createAction,
  testAction,
  createLabel,
  noun,
}: PluginConfiguratorProps) {
  const [selected, setSelected] = useState(catalog[0]?.id ?? "");
  const [createState, create, creating] = useActionState(
    createAction,
    EMPTY_STATE,
  );
  const [testState, test, testing] = useActionState(testAction, EMPTY_STATE);

  if (catalog.length === 0) {
    return (
      <p className="muted">
        Every {noun} plugin type is disabled in Settings.
      </p>
    );
  }

  const plugin = catalog.find((entry) => entry.id === selected) ?? catalog[0]!;

  return (
    <form action={create} className="stack">
      <div className="field">
        <label htmlFor="pluginId">Type</label>
        <select
          id="pluginId"
          name="pluginId"
          value={plugin.id}
          onChange={(event) => setSelected(event.target.value)}
        >
          {catalog.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <p className="hint">{plugin.description}</p>
      </div>

      <div className="field">
        <label htmlFor="label">Name</label>
        <input
          id="label"
          name="label"
          type="text"
          required
          placeholder={`My ${plugin.label}`}
        />
      </div>

      {/* Remount on plugin change so stale defaults do not leak across types. */}
      <SchemaForm key={plugin.id} fields={plugin.fields} idPrefix={plugin.id} />

      <div className="row">
        <button type="submit" className="btn primary" disabled={creating}>
          {creating ? "Saving..." : createLabel}
        </button>
        <button
          type="submit"
          className="btn plain"
          formAction={test}
          formNoValidate
          disabled={testing}
        >
          {testing ? "Testing..." : "Test"}
        </button>
      </div>

      {testState.message ? (
        <p className={testState.ok ? "ok-msg" : "err-msg"}>
          {testState.message}
        </p>
      ) : null}
      {createState.message ? (
        <p className={createState.ok ? "ok-msg" : "err-msg"}>
          {createState.message}
        </p>
      ) : null}
    </form>
  );
}
