import { db } from "../../../../db/client.js";
import { serveArtifact } from "../../../../lib/artifacts.js";

/**
 * Streams a stored artifact out of DATA_DIR. The path-traversal guard and the
 * range handling live in lib/artifacts.ts so they are unit tested without a
 * running server; this handler only wires in the real database.
 *
 * Middleware protects this route: the audio is as sensitive as the pages that
 * link to it.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return serveArtifact({ db: db() }, id, request.headers.get("range"));
}
