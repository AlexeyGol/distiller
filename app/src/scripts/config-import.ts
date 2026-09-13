// MUST be the first import: see src/env-init.ts.
import "../env-init.js";

import { readFileSync } from "node:fs";
import { db } from "../db/client.js";
import { importConfig, type ConfigBundle } from "../lib/config-transfer.js";

/**
 * Merge a configuration bundle into the database.
 *
 *   npm run config:import -- config.json
 *   npm run config:import -- config.json --require-secrets
 *
 * Upserts by natural key (topic slug, source label) and never deletes, so
 * importing a partial bundle cannot silently destroy something it does not
 * mention. Where a field is redacted, any existing value is kept.
 */
async function main() {
  const argv = process.argv.slice(2);
  const path = argv.find((a) => !a.startsWith("--"));

  if (!path) {
    console.error("usage: npm run config:import -- <file.json> [--require-secrets]");
    process.exit(2);
  }

  let bundle: ConfigBundle;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8")) as ConfigBundle;
  } catch (cause) {
    console.error(
      JSON.stringify({
        level: "fatal",
        error: `Could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
    process.exit(1);
    return;
  }

  const result = await importConfig(db(), bundle, {
    requireSecrets: argv.includes("--require-secrets"),
  });

  console.log(
    JSON.stringify({
      event: "config-imported",
      sources: result.sources,
      sinks: result.sinks,
      topics: result.topics,
      warnings: result.warnings.length,
    }),
  );

  // Warnings are the actionable part - a skipped source or a credential that
  // still needs filling in - so they print individually rather than as a count.
  for (const warning of result.warnings) {
    console.warn(`  warning: ${warning}`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", error: String(error) }));
  process.exit(1);
});
