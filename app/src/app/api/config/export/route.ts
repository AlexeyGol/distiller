import { db } from "../../../../db/client.js";
import { exportConfig } from "../../../../lib/config-transfer.js";

export const dynamic = "force-dynamic";

/**
 * Download the configuration bundle.
 *
 *   GET /api/config/export              redacted, safe to share
 *   GET /api/config/export?secrets=1    real credentials included
 *
 * A route handler rather than a server action because the point is a file
 * download, and only a real response can carry Content-Disposition.
 *
 * Auth: everything except /login and /_next goes through the middleware, so
 * this is behind the session cookie. That matters more here than anywhere else
 * in the app - with `secrets=1` this endpoint hands over every API key and bot
 * token in one request.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const includeSecrets = url.searchParams.get("secrets") === "1";

  const bundle = await exportConfig(db(), { includeSecrets });

  const stamp = new Date().toISOString().slice(0, 10);
  const name = includeSecrets
    ? `distiller-config-${stamp}.secrets.json`
    : `distiller-config-${stamp}.json`;

  return new Response(`${JSON.stringify(bundle, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      // A bundle carrying credentials must not sit in a proxy or browser cache.
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
