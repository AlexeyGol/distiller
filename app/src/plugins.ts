import { PluginRegistry } from "./core/registry.js";
import { sourcePlugins } from "./core/sources/index.js";
import { rendererPlugins } from "./renderers/index.js";
import { sinkPlugins } from "./sinks/index.js";

/**
 * The one place that knows every plugin type in the build.
 *
 * Adding a plugin means adding it to its directory's index and nothing else:
 * the UI discovers types through this registry and renders their config forms
 * from each plugin's Zod schema, so no UI change is needed.
 */
export function buildRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of sourcePlugins) registry.registerSource(plugin);
  for (const plugin of rendererPlugins) registry.registerRenderer(plugin);
  for (const plugin of sinkPlugins) registry.registerSink(plugin);
  return registry;
}

let singleton: PluginRegistry | undefined;

/** Shared registry for the app and worker processes. */
export function registry(): PluginRegistry {
  singleton ??= buildRegistry();
  return singleton;
}

/**
 * Plugin metadata for the UI catalog. The UI never imports a concrete plugin,
 * it renders whatever this returns.
 */
export interface PluginSummary {
  id: string;
  kind: "source" | "renderer" | "sink";
  label: string;
  description: string;
}

export function listPluginSummaries(
  reg: PluginRegistry = registry(),
): PluginSummary[] {
  return [
    ...reg.listSources().map((p) => summarize(p, "source" as const)),
    ...reg.listRenderers().map((p) => summarize(p, "renderer" as const)),
    ...reg.listSinks().map((p) => summarize(p, "sink" as const)),
  ];
}

function summarize(
  plugin: { id: string; label: string; description: string },
  kind: "source" | "renderer" | "sink",
): PluginSummary {
  return {
    id: plugin.id,
    kind,
    label: plugin.label,
    description: plugin.description,
  };
}
