import { describe, expect, it } from "vitest";
import { rendererPlugins } from "./index.js";
import { sinkPlugins } from "../sinks/index.js";

/**
 * Smoke test for the barrels: the modules must load without touching any
 * network or provider package, and the ids must be unique or the registry
 * throws at startup.
 */
describe("plugin barrels", () => {
  it("exports the renderers with unique ids", () => {
    expect(rendererPlugins.map((p) => p.id)).toEqual([
      "llm-text",
      "notebooklm",
    ]);
    expect(rendererPlugins.every((p) => p.kind === "renderer")).toBe(true);
  });

  it("exports the sinks with unique ids", () => {
    expect(sinkPlugins.map((p) => p.id)).toEqual(["telegram"]);
    expect(sinkPlugins.every((p) => p.kind === "sink")).toBe(true);
  });
});
