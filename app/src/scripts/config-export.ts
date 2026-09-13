// MUST be the first import: see src/env-init.ts.
import "../env-init.js";

import { writeFileSync } from "node:fs";
import { db } from "../db/client.js";
import { exportConfig } from "../lib/config-transfer.js";

/**
 * Dump the configuration as JSON: topics, sources, sinks, keywords, settings.
 *
 *   npm run config:export                       # redacted, safe to share
 *   npm run config:export -- --with-secrets     # restorable backup
 *   npm run config:export -- --out config.json
 *
 * Secrets are redacted unless asked for, because the common uses - sharing a
 * setup, committing it, pasting it into an issue - must not leak a bot token.
 */
async function main() {
  const argv = process.argv.slice(2);
  const includeSecrets = argv.includes("--with-secrets");

  const outFlag = argv.indexOf("--out");
  const outPath = outFlag !== -1 ? argv[outFlag + 1] : undefined;

  const bundle = await exportConfig(db(), { includeSecrets });
  const json = `${JSON.stringify(bundle, null, 2)}\n`;

  if (outPath) {
    writeFileSync(outPath, json, { mode: includeSecrets ? 0o600 : 0o644 });
    // A file holding real credentials is created 0600 rather than left at the
    // umask default, since the whole point of --with-secrets is that it is
    // sensitive.
    console.error(
      JSON.stringify({
        event: "config-exported",
        out: outPath,
        secretsIncluded: includeSecrets,
        topics: bundle.topics.length,
        sources: bundle.sources.length,
        sinks: bundle.sinks.length,
        mode: includeSecrets ? "0600" : "0644",
      }),
    );
  } else {
    // stdout stays clean JSON so it can be piped; status goes to stderr.
    process.stdout.write(json);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", error: String(error) }));
  process.exit(1);
});
