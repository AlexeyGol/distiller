import type { NextConfig } from "next";

/**
 * `pg` and `rss-parser` are CommonJS packages with dynamic requires that the
 * bundler cannot follow; leaving them external is what keeps the server build
 * working. pglite is test-only and must never be pulled into a page bundle.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "rss-parser"],
  experimental: {
    // Server Actions here carry only form fields and ids, never uploads.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
