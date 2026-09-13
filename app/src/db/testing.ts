import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";

/**
 * An in-process Postgres for tests.
 *
 * pglite is real Postgres compiled to WASM, so migrations, constraints,
 * ON CONFLICT and foreign keys all behave exactly as they will in production.
 * That matters here: the dedup path depends on a real UNIQUE constraint, and
 * a SQLite or mock-based test would not prove it works.
 *
 * The alternative - requiring Docker for `npm test` - makes the suite
 * unrunnable in exactly the situations where you most want to run it.
 */
export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDb {
  db: TestDatabase;
  client: PGlite;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * Create a fresh, isolated, migrated database. Each call gets its own
 * in-memory instance, so suites cannot leak state into each other.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return {
    db,
    client,
    async close() {
      await client.close();
    },
  };
}
