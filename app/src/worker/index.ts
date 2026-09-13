// MUST be the first import: ES imports are evaluated before any statement, so
// a loadEnv() call here would run too late for anything reading process.env at
// module scope. See src/env-init.ts.
import "../env-init.js";

import PgBoss from "pg-boss";
import { createDatabase } from "../db/client.js";
import { registry } from "../plugins.js";
import {
  ensureSettings,
  pollAllSources,
  renderAndDeliver,
  runRetention,
  runTopicCycle,
  scheduledTopics,
  type JobDeps,
} from "./jobs.js";
import { unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * The worker process.
 *
 * Runs separately from the Next.js server on purpose: Next's server is not a
 * job host (module reloading in dev, multiple instances, lifecycle
 * assumptions), and a queue consumer living inside it would fire jobs twice
 * or lose them on reload.
 *
 * This file is the ONLY place that knows pg-boss exists. Everything it
 * schedules lives in jobs.ts and is tested directly against a database.
 */

const QUEUE = {
  pollAll: "poll-all",
  topicCycle: "topic-cycle",
  renderDeliver: "render-and-deliver",
  retention: "retention",
} as const;

const DATA_DIR = process.env.DATA_DIR ?? "/data";

function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

/**
 * Delete an artifact file, refusing anything that escapes the data directory.
 * Retention walks paths that came from a database row, so it must not be able
 * to unlink outside the volume even if a row is wrong.
 */
async function removeArtifactFile(relativePath: string): Promise<void> {
  const base = resolve(DATA_DIR);
  const target = resolve(join(base, relativePath));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to delete outside the data directory: ${relativePath}`);
  }
  await unlink(target);
}

export async function start(): Promise<PgBoss> {
  const connectionString =
    process.env.DATABASE_URL ??
    "postgres://distiller:distiller@localhost:5432/distiller";

  const db = createDatabase(connectionString);
  const deps: JobDeps = {
    db,
    registry: registry(),
    removeFile: removeArtifactFile,
    dataDir: DATA_DIR,
    log,
  };

  await ensureSettings(db);

  const boss = new PgBoss({ connectionString });
  boss.on("error", (error) => log({ level: "error", scope: "pg-boss", error: String(error) }));
  await boss.start();

  for (const queue of Object.values(QUEUE)) {
    await boss.createQueue(queue);
  }

  await boss.work(QUEUE.pollAll, async () => {
    await pollAllSources(deps);
  });

  await boss.work<{ topicId: string }>(QUEUE.topicCycle, async ([job]) => {
    await runTopicCycle(deps, job.data.topicId);
  });

  await boss.work<{ digestId: string }>(QUEUE.renderDeliver, async ([job]) => {
    await renderAndDeliver(deps, job.data.digestId);
  });

  await boss.work(QUEUE.retention, async () => {
    await runRetention(deps);
  });

  await scheduleEverything(boss, deps);

  log({ event: "worker-started", dataDir: DATA_DIR });
  return boss;
}

/**
 * Register cron schedules. Called at boot and re-callable when topics change,
 * since a schedule edited in the UI must take effect without a restart.
 */
export async function scheduleEverything(
  boss: PgBoss,
  deps: JobDeps,
): Promise<void> {
  // Polling is global and frequent; building digests is per-topic and is
  // where the user-configured cadence applies.
  await boss.schedule(QUEUE.pollAll, process.env.POLL_SCHEDULE ?? "*/30 * * * *");
  await boss.schedule(QUEUE.retention, "30 3 * * *");

  for (const { topic, schedule } of await scheduledTopics(deps.db)) {
    try {
      await boss.schedule(QUEUE.topicCycle, schedule, { topicId: topic.id });
    } catch (cause) {
      // One malformed cron string must not stop the other topics from running.
      log({
        level: "error",
        event: "bad-schedule",
        topicId: topic.id,
        schedule,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

// Only auto-start when executed directly, so tests can import this module.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""));

if (isDirectRun) {
  start().catch((error) => {
    log({ level: "fatal", error: String(error) });
    process.exit(1);
  });
}

export { QUEUE, removeArtifactFile };
