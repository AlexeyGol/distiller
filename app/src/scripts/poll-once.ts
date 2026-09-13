// MUST be the first import: ES imports are evaluated before any statement, so
// a loadEnv() call here would run too late for anything reading process.env at
// module scope. See src/env-init.ts.
import "../env-init.js";

import { db } from "../db/client.js";
import { registry } from "../plugins.js";
import { pollAllSources } from "../worker/jobs.js";

/**
 * Poll every enabled source once and exit.
 *
 * Useful for getting real data into a fresh install without waiting for the
 * worker's cron, and for checking that a newly added source actually works
 * against the live feed rather than only against test fixtures.
 */
async function main() {
  const result = await pollAllSources({ db: db(), registry: registry() });

  for (const source of result.results) {
    console.log(
      JSON.stringify({
        sourceId: source.sourceId,
        fetched: source.fetched,
        inserted: source.inserted,
        ...(source.error ? { error: source.error } : {}),
      }),
    );
  }

  console.log(
    JSON.stringify({
      event: "poll-complete",
      sources: result.sources,
      inserted: result.inserted,
      failed: result.failed,
    }),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", error: String(error) }));
  process.exit(1);
});
