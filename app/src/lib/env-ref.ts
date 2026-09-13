/**
 * Environment-variable references in plugin config.
 *
 * A config value may be written as `${YOUTUBE_API_KEY}` instead of a literal.
 * The reference is what gets stored; the real value is looked up at the moment
 * the plugin runs.
 *
 * Why this exists. Storing credentials in the database works, but it makes the
 * database credential-bearing: every dump, every config export and every
 * screenshot of the sources table becomes sensitive. A reference is not a
 * secret, so with references the whole chain - database, backup, export,
 * screenshot - carries nothing worth stealing, and the actual values live in
 * exactly one place that already has to be protected: the environment. That is
 * also where a Kubernetes Secret, a systemd credential or a Vault agent puts
 * them, so this is the form that survives the move off Docker Compose.
 *
 * Literals still work. Pasting a key straight into the UI is the fastest way to
 * get a source running, and demanding a server restart to add one would be a
 * poor trade for a self-hosted app. References are the option you reach for
 * when you want the database to stop being a place secrets live.
 *
 * Per-instance flexibility is preserved either way: two Telegram sinks can
 * reference `${TELEGRAM_BOT_TOKEN_A}` and `${TELEGRAM_BOT_TOKEN_B}`, which a
 * single hardcoded variable per plugin type could not express.
 */

/** `${NAME}` or `${NAME:-fallback}`, anchored so only a whole value counts. */
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/s;

export interface EnvRef {
  name: string;
  fallback?: string;
}

/**
 * Parse a value that is entirely one reference.
 *
 * Deliberately not a substring substitution. A partial match would make
 * "costs ${100}" or a password containing `${` behave surprisingly, and the
 * whole-value rule means a reference is always visibly a reference.
 */
export function parseEnvRef(value: unknown): EnvRef | null {
  if (typeof value !== "string") return null;
  const match = ENV_REF.exec(value);
  if (!match) return null;
  return { name: match[1]!, fallback: match[2] };
}

export function isEnvRef(value: unknown): boolean {
  return parseEnvRef(value) !== null;
}

export class MissingEnvError extends Error {
  readonly variable: string;
  readonly field: string;
  constructor(variable: string, field: string) {
    super(
      `Config field "${field}" references environment variable ${variable}, which is not set. ` +
        `Add ${variable} to the environment (.env for docker compose, or a Secret on Kubernetes) and restart.`,
    );
    this.name = "MissingEnvError";
    this.variable = variable;
    this.field = field;
  }
}

/**
 * Replace every reference in a config object with its environment value.
 *
 * Throws on a missing variable rather than substituting an empty string: a
 * source that silently polls with an empty API key produces a confusing 403
 * far from the cause, while this names both the variable and the field.
 */
export function resolveEnvRefs(
  config: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const ref = parseEnvRef(value);
    if (!ref) {
      out[key] = value;
      continue;
    }

    const resolved = env[ref.name];
    if (resolved !== undefined && resolved !== "") {
      out[key] = resolved;
    } else if (ref.fallback !== undefined) {
      out[key] = ref.fallback;
    } else {
      throw new MissingEnvError(`$${ref.name}`, key);
    }
  }
  return out;
}

/**
 * Which environment variables a stored config depends on. Used to tell an
 * operator what a bundle needs before they import it.
 */
export function referencedVariables(config: unknown): string[] {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  const names = new Set<string>();
  for (const value of Object.values(config as Record<string, unknown>)) {
    const ref = parseEnvRef(value);
    if (ref) names.add(ref.name);
  }
  return [...names].sort();
}
