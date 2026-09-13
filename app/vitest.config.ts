import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // pglite spins up a WASM Postgres per suite; give it room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
