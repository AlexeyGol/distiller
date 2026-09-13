// MUST be the first import: ES imports are evaluated before any statement, so
// a loadEnv() call here would run too late for anything reading process.env at
// module scope. See src/env-init.ts.
import "../env-init.js";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Apply migrations against the real database. Run on deploy, before the app
 * and worker start serving.
 */
async function main() {
  const connectionString =
    process.env.DATABASE_URL ??
    "postgres://distiller:distiller@localhost:5432/distiller";

  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool);

  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );

  await migrate(db, { migrationsFolder });
  await pool.end();

  console.log(JSON.stringify({ event: "migrations-applied", migrationsFolder }));
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", error: String(error) }));
  process.exit(1);
});
