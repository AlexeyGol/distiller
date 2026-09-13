import type { RendererPlugin } from "../core/types.js";
import { llmTextRenderer } from "./llm-text.js";
import { notebookLmRenderer } from "./notebooklm.js";

export * from "./llm-text.js";
export * from "./notebooklm.js";

/**
 * Every renderer the registry knows about.
 *
 * llm-text comes first deliberately: it is the default and the fallback, and
 * the order is what the "add a renderer" catalog shows.
 */
export const rendererPlugins: RendererPlugin<any>[] = [
  llmTextRenderer,
  notebookLmRenderer,
];
