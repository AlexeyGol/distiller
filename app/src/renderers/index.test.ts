import { describe, expect, it } from "vitest";
import { rendererPlugins } from "./index.js";
import { sinkPlugins } from "../sinks/index.js";

/**
 * Smoke test for the barrels: the modules must load without touching any
 * network or provider package, and the ids must be unique or the registry
 * throws at startup.
 */
describe("plugin barrels", () => {
  it("exports the renderers cheapest-first with unique ids", () => {
    // Order is what the picker shows, and the audio renderer is last on
    // purpose: it holds the scarce budget, so it should be a deliberate choice.
    expect(rendererPlugins.map((p) => p.id)).toEqual([
      "llm-text",
      "notebooklm-text",
      "notebooklm",
    ]);
    expect(rendererPlugins.every((p) => p.kind === "renderer")).toBe(true);
  });

  it("offers a NotebookLM summary that does not spend the audio budget", () => {
    const text = rendererPlugins.find((p) => p.id === "notebooklm-text")!;
    const audio = rendererPlugins.find((p) => p.id === "notebooklm")!;

    expect(text.produces).toEqual({ text: true, audio: false });
    expect(audio.produces).toEqual({ text: true, audio: true });
    // The whole point: asking is cheap, generating a podcast is not.
    expect(text.dailyBudget).toBeGreaterThan(audio.dailyBudget!);
  });

  it("exports the sinks with unique ids", () => {
    expect(sinkPlugins.map((p) => p.id)).toEqual(["telegram"]);
    expect(sinkPlugins.every((p) => p.kind === "sink")).toBe(true);
  });
});
