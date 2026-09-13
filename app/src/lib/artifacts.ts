import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { artifacts } from "../db/schema.js";

/**
 * Serving stored artifacts over HTTP.
 *
 * In-app playback is the app reading its own artifact store; it is not a
 * plugin seam and has no alternative implementation.
 *
 * `artifacts.path` is written by renderer plugins, so it is treated as
 * untrusted input: the resolved path must provably stay inside DATA_DIR before
 * a single byte is read.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.DATA_DIR?.trim() || "/data";
}

/**
 * Resolve a stored relative path inside the data directory, or null if it
 * escapes. Absolute paths are rejected outright rather than normalised: a
 * stored artifact has no business pointing outside the volume, and silently
 * accepting one would defeat the check below.
 */
export function resolveArtifactPath(
  dir: string,
  relative: string | null | undefined,
): string | null {
  if (!relative) return null;
  if (relative.includes("\0")) return null;
  if (isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) return null;

  const root = resolve(dir);
  const candidate = resolve(join(root, relative));

  // Equality matters for the root itself; the separator suffix is what stops
  // "/data-other" from passing a naive startsWith("/data") check.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

export interface ArtifactDeps {
  db: Database;
  /** Overridable so tests can point at a temp directory. */
  dataDir?: string;
}

interface RangeSpec {
  start: number;
  end: number;
}

/** Parse a single-range `bytes=` header. Multi-range is not supported. */
export function parseRange(
  header: string | null | undefined,
  size: number,
): RangeSpec | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;

  let start: number;
  let end: number;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

function fileBody(path: string, range: RangeSpec | null): BodyInit {
  const stream = createReadStream(
    path,
    range ? { start: range.start, end: range.end } : undefined,
  );
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * GET one artifact by id. Returns a Response so the route handler is a
 * one-liner and the whole thing stays testable without a Next server.
 */
export async function serveArtifact(
  deps: ArtifactDeps,
  id: string,
  rangeHeader?: string | null,
): Promise<Response> {
  if (!UUID_RE.test(id)) {
    return new Response("Not found", { status: 404 });
  }

  const [row] = await deps.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, id));

  if (!row) return new Response("Not found", { status: 404 });

  // Inline text artifacts never touch the filesystem.
  if (!row.path) {
    if (row.text === null) return new Response("Not found", { status: 404 });
    return new Response(row.text, {
      status: 200,
      headers: {
        "content-type": row.mime || "text/plain; charset=utf-8",
        "cache-control": "private, max-age=0, must-revalidate",
      },
    });
  }

  const root = deps.dataDir ?? dataDir();
  const absolute = resolveArtifactPath(root, row.path);
  if (!absolute) {
    return new Response("Invalid artifact path", { status: 400 });
  }

  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    size = info.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const contentType = row.mime || "application/octet-stream";
  const range = parseRange(rangeHeader, size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    return new Response(fileBody(absolute, range), {
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(length),
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "accept-ranges": "bytes",
      },
    });
  }

  return new Response(fileBody(absolute, null), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}
