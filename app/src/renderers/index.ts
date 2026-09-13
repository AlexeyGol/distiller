import type { RendererPlugin } from "../core/types.js";
import { llmTextRenderer } from "./llm-text.js";
import {
  notebookLmRenderer,
  notebookLmTextRenderer,
} from "./notebooklm.js";

export * from "./llm-text.js";
export * from "./notebooklm.js";

/**
 * Every renderer the registry knows about.
 *
 * Ordered cheapest-first, which is also the order the picker shows:
 *
 *   llm-text        no NotebookLM dependency at all; the fallback
 *   notebooklm-text source-grounded summary, ~500/day, seconds
 *   notebooklm      summary plus a podcast, only 20/day, minutes
 *
 * Putting the audio renderer last is deliberate. It is the one with the scarce
 * budget, so it should be a considered choice rather than the obvious default.
 */
export const rendererPlugins: RendererPlugin<any>[] = [
  llmTextRenderer,
  notebookLmTextRenderer,
  notebookLmRenderer,
];
