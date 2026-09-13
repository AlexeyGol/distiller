import { loadEnv } from "./env.js";

/**
 * Side-effect module: importing it loads `.env.local` / `.env`.
 *
 * This exists instead of calling `loadEnv()` at the top of each entry point
 * because ES module imports are **hoisted and evaluated before any statement**
 * in the importing module. A bare `loadEnv()` call therefore runs after every
 * imported module has already been evaluated, so anything reading
 * `process.env` at module scope would see nothing - and would fail silently, by
 * quietly falling back to a default rather than raising.
 *
 * Import ordering IS evaluation ordering, so making this an import and putting
 * it first is the only placement that actually guarantees the environment is
 * populated before other modules load.
 *
 *     import "../env-init.js";   // must be the first import
 *     import { db } from "../db/client.js";
 *
 * Not needed under Next.js, which loads `.env.local` itself, and a no-op in
 * Docker where compose sets the environment and no file exists.
 */
loadEnv();
