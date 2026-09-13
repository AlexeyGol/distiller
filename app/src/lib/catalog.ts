import type { Database } from "../db/client.js";
import type { PluginRegistry } from "../core/registry.js";
import { registry } from "../plugins.js";
import { describeSchema, type FormField } from "./schema-form.js";
import { loadPluginToggles } from "./mutations.js";

/**
 * The plugin catalog the UI renders: id, prose, and the field descriptors
 * derived from the plugin own Zod schema.
 *
 * This is the boundary that keeps the UI plugin-agnostic. Everything here is
 * plain JSON, so it crosses to a Client Component untouched.
 */
export interface PluginCatalogEntry {
  id: string;
  label: string;
  description: string;
  fields: FormField[];
}

export type PluginKind = "source" | "renderer" | "sink";

function pluginsOf(reg: PluginRegistry, kind: PluginKind) {
  if (kind === "source") return reg.listSources();
  if (kind === "renderer") return reg.listRenderers();
  return reg.listSinks();
}

/**
 * @param includeDisabled keep types the operator switched off in Settings.
 * The settings page itself needs them; the "add new" catalogs do not.
 */
export async function pluginCatalog(
  db: Database,
  kind: PluginKind,
  options: { includeDisabled?: boolean; reg?: PluginRegistry } = {},
): Promise<PluginCatalogEntry[]> {
  const reg = options.reg ?? registry();
  const toggles = await loadPluginToggles(db);

  return pluginsOf(reg, kind)
    .filter(
      (plugin) =>
        options.includeDisabled ||
        toggles.get(`${kind}:${plugin.id}`) !== false,
    )
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.label,
      description: plugin.description,
      fields: describeSchema(plugin.configSchema),
    }));
}
