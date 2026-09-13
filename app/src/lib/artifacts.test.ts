import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../db/testing.js";
import type { Database } from "../db/client.js";
import { artifacts, digests, topics } from "../db/schema.js";
import {
  dataDir,
  parseRange,
  resolveArtifactPath,
  serveArtifact,
} from "./artifacts.js";

let harness: TestDb;
let db: Database;
let root: string;
let digestId: string;

const AUDIO = Buffer.from("ID3fake-audio-bytes-for-the-player");

beforeEach(async () => {
  harness = await createTestDb();
  db = harness.db as unknown as Database;
  root = await mkdtemp(join(tmpdir(), "distiller-artifacts-"));

  await mkdir(join(root, "digests"), { recursive: true });
  await writeFile(join(root, "digests", "episode.mp3"), AUDIO);
  // A file that exists OUTSIDE the data dir, to prove traversal is refused
  // because of the check and not because the target happens to be missing.
  await writeFile(join(root, "..", "distiller-secret.txt"), "master token");

  const [topic] = await db
    .insert(topics)
    .values({ name: "AI", slug: `ai-${Date.now()}` })
    .returning();
  const [digest] = await db
    .insert(digests)
    .values({
      topicId: topic!.id,
      jobKey: `job-${Date.now()}`,
      rendererId: "notebooklm",
      status: "ready",
    })
    .returning();
  digestId = digest!.id;
});

afterEach(async () => {
  await harness.close();
  await rm(root, { recursive: true, force: true });
  await rm(join(root, "..", "distiller-secret.txt"), { force: true });
});

async function storeArtifact(values: {
  kind: string;
  mime: string;
  path?: string | null;
  text?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(artifacts)
    .values({
      digestId,
      kind: values.kind,
      mime: values.mime,
      path: values.path ?? null,
      text: values.text ?? null,
    })
    .returning();
  return row!.id;
}

describe("resolveArtifactPath", () => {
  it("resolves a normal relative path inside the data dir", () => {
    expect(resolveArtifactPath("/data", "digests/a.mp3")).toBe(
      "/data/digests/a.mp3",
    );
  });

  it("rejects dot-dot traversal", () => {
    expect(resolveArtifactPath("/data", "../etc/passwd")).toBeNull();
    expect(resolveArtifactPath("/data", "digests/../../etc/passwd")).toBeNull();
    expect(resolveArtifactPath("/data", "./../../root/.ssh/id_rsa")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(resolveArtifactPath("/data", "/etc/passwd")).toBeNull();
    expect(resolveArtifactPath("/data", "C:\\Windows\\win.ini")).toBeNull();
  });

  it("rejects a sibling directory that merely shares the prefix", () => {
    expect(resolveArtifactPath("/data", "../data-other/x.mp3")).toBeNull();
  });

  it("rejects a NUL byte and empty input", () => {
    expect(resolveArtifactPath("/data", "a\0b")).toBeNull();
    expect(resolveArtifactPath("/data", "")).toBeNull();
    expect(resolveArtifactPath("/data", null)).toBeNull();
  });

  it("defaults DATA_DIR to /data", () => {
    expect(dataDir({})).toBe("/data");
    expect(dataDir({ DATA_DIR: "/srv/files" })).toBe("/srv/files");
  });
});

describe("serveArtifact", () => {
  it("serves an audio file with the stored content type", async () => {
    const id = await storeArtifact({
      kind: "audio",
      mime: "audio/mpeg",
      path: "digests/episode.mp3",
    });

    const response = await serveArtifact({ db, dataDir: root }, id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(AUDIO.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AUDIO);
  });

  it("serves an inline text artifact without touching the filesystem", async () => {
    const id = await storeArtifact({
      kind: "text",
      mime: "text/markdown; charset=utf-8",
      text: "# Digest",
    });

    const response = await serveArtifact({ db, dataDir: root }, id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await response.text()).toBe("# Digest");
  });

  it("rejects a stored path that escapes DATA_DIR", async () => {
    const id = await storeArtifact({
      kind: "text",
      mime: "text/plain",
      path: "../distiller-secret.txt",
    });

    const response = await serveArtifact({ db, dataDir: root }, id);

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("master token");
  });

  it("rejects an absolute stored path", async () => {
    const id = await storeArtifact({
      kind: "audio",
      mime: "audio/mpeg",
      path: join(root, "digests", "episode.mp3"),
    });

    const response = await serveArtifact({ db, dataDir: root }, id);
    expect(response.status).toBe(400);
  });

  it("404s an artifact id that does not exist", async () => {
    const response = await serveArtifact(
      { db, dataDir: root },
      "11111111-1111-4111-8111-111111111111",
    );
    expect(response.status).toBe(404);
  });

  it("404s a malformed id without hitting the database", async () => {
    const response = await serveArtifact({ db, dataDir: root }, "not-a-uuid");
    expect(response.status).toBe(404);
  });

  it("404s when the row exists but the file is gone", async () => {
    const id = await storeArtifact({
      kind: "audio",
      mime: "audio/mpeg",
      path: "digests/missing.mp3",
    });

    const response = await serveArtifact({ db, dataDir: root }, id);
    expect(response.status).toBe(404);
  });

  it("serves a byte range so the player can seek", async () => {
    const id = await storeArtifact({
      kind: "audio",
      mime: "audio/mpeg",
      path: "digests/episode.mp3",
    });

    const response = await serveArtifact({ db, dataDir: root }, id, "bytes=4-9");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 4-9/${AUDIO.length}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      AUDIO.subarray(4, 10),
    );
  });

  it("416s a range past the end of the file", async () => {
    const id = await storeArtifact({
      kind: "audio",
      mime: "audio/mpeg",
      path: "digests/episode.mp3",
    });

    const response = await serveArtifact(
      { db, dataDir: root },
      id,
      "bytes=99999-",
    );
    expect(response.status).toBe(416);
  });
});

describe("parseRange", () => {
  it("parses a closed range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range and clamps it", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=0-99999", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("returns null for an absent or unparseable header", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange("bytes=a-b", 1000)).toBeNull();
  });

  it("flags an unsatisfiable range", () => {
    expect(parseRange("bytes=5000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=10-5", 1000)).toBe("unsatisfiable");
  });
});
