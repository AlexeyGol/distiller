import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env.local` for the scripts Next.js does not start.
 *
 * Next loads `.env.local` itself, so `npm run dev` has always worked. Every
 * other entry point - the worker, migrate, seed, poll - runs under plain `tsx`,
 * which loads nothing, so they silently saw no DATABASE_URL and fell back to
 * defaults. The symptom is not an error, it is the worker cheerfully connecting
 * to the wrong database.
 *
 * **Real environment variables always win.** In Docker, compose sets the
 * environment directly and there is no `.env.local` in the image, so this is a
 * no-op there. That ordering is what lets the same entry point work unchanged in
 * development and in a container.
 *
 * Deliberately dependency-free: pulling in dotenv to parse a handful of
 * KEY=value lines is not worth a supply-chain entry, and Node 20.11 predates
 * `--env-file-if-exists`, whose plain `--env-file` form errors when the file is
 * absent - exactly the Docker case.
 */

const QUOTED = /^(['"])(.*)\1$/s;

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key === "") continue;

    let value = line.slice(eq + 1).trim();

    // Strip one matching pair of surrounding quotes. A Telegram token or an
    // API key may legitimately contain '#', so only strip a trailing comment
    // from unquoted values, and only when it is clearly separated.
    const quoted = QUOTED.exec(value);
    if (quoted) {
      value = quoted[2]!;
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * Apply a parsed env file without clobbering anything already set.
 * Returns the keys it actually applied, which is what the caller logs.
 */
export function applyEnv(
  values: Record<string, string>,
  // Not NodeJS.ProcessEnv: that type requires NODE_ENV, which makes a plain
  // object awkward to pass in tests for no benefit. All we need is the index
  // signature, and process.env satisfies it.
  target: Record<string, string | undefined> = process.env,
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined) {
      target[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/** Directory containing package.json, whichever entry point is running. */
function appRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Load `.env.local` then `.env` if present. Safe to call more than once, and a
 * missing file is not an error - in Docker neither exists and the environment
 * is already populated.
 */
export function loadEnv(root: string = appRoot()): string[] {
  const applied: string[] = [];

  for (const name of [".env.local", ".env"]) {
    try {
      const contents = readFileSync(resolve(root, name), "utf8");
      applied.push(...applyEnv(parseEnvFile(contents)));
    } catch {
      // Absent or unreadable: expected in a container, not worth reporting.
    }
  }

  return applied;
}
