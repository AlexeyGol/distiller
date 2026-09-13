"use client";

import { useState } from "react";
import { SchemaForm } from "./SchemaForm.js";
import type { PluginCatalogEntry } from "../lib/catalog.js";

/**
 * Renderer selector plus the config form that renderer describes. Same idea as
 * PluginConfigurator, but it lives inside a larger topic form rather than
 * owning its own submit.
 */
export function RendererPicker({
  catalog,
  selectedId,
  values,
}: {
  catalog: PluginCatalogEntry[];
  selectedId?: string;
  values?: Record<string, unknown>;
}) {
  const [selected, setSelected] = useState(
    selectedId ?? catalog[0]?.id ?? "",
  );

  if (catalog.length === 0) {
    return <p className="muted">Every renderer plugin type is disabled.</p>;
  }

  const plugin = catalog.find((entry) => entry.id === selected) ?? catalog[0]!;
  // Config only carries over while the renderer is unchanged; another plugin
  // has a different schema, so reusing the values would be nonsense.
  const initial = plugin.id === selectedId ? values : undefined;

  return (
    <>
      <div className="field">
        <label htmlFor="rendererId">Renderer</label>
        <select
          id="rendererId"
          name="rendererId"
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

      <SchemaForm
        key={plugin.id}
        fields={plugin.fields}
        prefix="renderer."
        values={initial}
        idPrefix={`r-${plugin.id}`}
      />
    </>
  );
}
