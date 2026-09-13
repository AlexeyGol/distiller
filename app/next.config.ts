import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `pg` and `rss-parser` are CommonJS packages with dynamic requires the
 * bundler cannot follow; leaving them external keeps the server build working.
 */
const nextConfig: NextConfig = {
  // Without this, a lockfile further up the filesystem is picked as the root.
  outputFileTracingRoot: here,
  serverExternalPackages: ["pg", "rss-parser"],
  experimental: {
    // Server Actions here carry only form fields and ids, never uploads.
    serverActions: { bodySizeLimit: "2mb" },
  },
  webpack(config) {
    // The codebase uses explicit .js extensions on local imports (ESM style,
    // required by the worker and the test runner). TypeScript resolves those
    // to .ts itself; webpack needs to be told.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};

export default nextConfig;
