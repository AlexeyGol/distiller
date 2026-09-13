import type {
  RendererPlugin,
  SinkPlugin,
  SourcePlugin,
} from "./types.js";

/**
 * The plugin registry: the single place that knows which plugin types exist.
 *
 * Deliberately a static, in-repo registry rather than runtime loading. For a
 * single-tenant self-hosted app the plugin author is the operator, so sandboxing
 * buys nothing and costs a versioned ABI plus capability grants.
 *
 * Enable/disable is two-level and lives in the database, not here:
 *   - type level   (plugin_settings) hides a type and pauses its instances
 *   - instance level (sources.enabled / sinks.enabled) pauses one of them
 */

export class PluginRegistry {
  private readonly sourceMap = new Map<string, SourcePlugin<any>>();
  private readonly rendererMap = new Map<string, RendererPlugin<any>>();
  private readonly sinkMap = new Map<string, SinkPlugin<any>>();

  registerSource(plugin: SourcePlugin<any>): this {
    this.assertUnused(this.sourceMap, plugin.id, "source");
    this.sourceMap.set(plugin.id, plugin);
    return this;
  }

  registerRenderer(plugin: RendererPlugin<any>): this {
    this.assertUnused(this.rendererMap, plugin.id, "renderer");
    this.rendererMap.set(plugin.id, plugin);
    return this;
  }

  registerSink(plugin: SinkPlugin<any>): this {
    this.assertUnused(this.sinkMap, plugin.id, "sink");
    this.sinkMap.set(plugin.id, plugin);
    return this;
  }

  private assertUnused(
    map: Map<string, unknown>,
    id: string,
    kind: string,
  ): void {
    if (map.has(id)) {
      throw new Error(`Duplicate ${kind} plugin id: "${id}"`);
    }
  }

  getSource(id: string): SourcePlugin<any> | undefined {
    return this.sourceMap.get(id);
  }

  getRenderer(id: string): RendererPlugin<any> | undefined {
    return this.rendererMap.get(id);
  }

  getSink(id: string): SinkPlugin<any> | undefined {
    return this.sinkMap.get(id);
  }

  /**
   * Lookup that fails loudly. Use when a stored row references a plugin id:
   * a missing plugin means the row was written by a newer build, and silently
   * skipping it would lose data without telling anyone.
   */
  requireSource(id: string): SourcePlugin<any> {
    const found = this.sourceMap.get(id);
    if (!found) throw new Error(`Unknown source plugin: "${id}"`);
    return found;
  }

  requireRenderer(id: string): RendererPlugin<any> {
    const found = this.rendererMap.get(id);
    if (!found) throw new Error(`Unknown renderer plugin: "${id}"`);
    return found;
  }

  requireSink(id: string): SinkPlugin<any> {
    const found = this.sinkMap.get(id);
    if (!found) throw new Error(`Unknown sink plugin: "${id}"`);
    return found;
  }

  listSources(): SourcePlugin<any>[] {
    return [...this.sourceMap.values()];
  }

  listRenderers(): RendererPlugin<any>[] {
    return [...this.rendererMap.values()];
  }

  listSinks(): SinkPlugin<any>[] {
    return [...this.sinkMap.values()];
  }
}
