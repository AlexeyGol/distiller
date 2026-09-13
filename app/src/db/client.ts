import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * Driver-agnostic handle.
 *
 * Deliberately NOT `ReturnType<typeof createDatabase>`: that pins the type to
 * node-postgres, and the test suite runs the exact same pipeline code against
 * pglite. Typing to the shared `PgDatabase` base is what lets one
 * implementation be exercised by both drivers instead of forcing a cast in
 * tests - a cast would hide real drift between the two.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Production database handle. Tests do NOT use this: they use the pglite
 * harness in ./testing.ts, which runs real Postgres in-process so the suite
 * needs no Docker and no running server.
 */
export function createDatabase(connectionString?: string) {
  const url =
    connectionString ??
    process.env.DATABASE_URL ??
    "postgres://distiller:distiller@localhost:5432/distiller";

  const pool = new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

let singleton: Database | undefined;

/** Lazily created shared handle for the app and worker processes. */
export function db(): Database {
  singleton ??= createDatabase();
  return singleton;
}
