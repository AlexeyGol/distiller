# Distiller: Implementation Plan & Initialization Guide

## What this is
Distiller is a self-hosted, single-tenant web app that polls content sources, filters items by
keywords, lets you curate what goes into a digest, renders that digest as text and optionally
audio, and delivers it wherever you want.

Three extension points are pluggable, all driven by self-describing manifests:
- **Source plugins**: where items come from (rss in v1; youtube, reddit later).
- **Renderer plugins**: items to digest content (notebooklm for audio, llm-text as fallback).
- **Sink plugins**: a finished digest to somewhere it lands (telegram, and later email, rss-out).

Everything else is deliberately boring.

**In-app playback is not a plugin.** It is the app reading its own stored artifact. Resist the
urge to make it one; it would have no config and no alternative implementation.

## Design decisions (and why)

### 1. Plugin model: in-repo registry + schema-driven UI + two-level toggles
Plugin types are TypeScript modules compiled into the app and listed in a central registry.
The UI never knows about a specific plugin: each plugin exports a Zod `configSchema`, the UI
renders the config form from that schema, and the DB stores instance config as JSONB.

Two independent on/off switches:
- **Type level** (`plugin_settings.enabled`): hides the type from the "add new" catalog and
  pauses every instance of it. Config is preserved, nothing is deleted.
- **Instance level** (`sources.enabled`, `sinks.enabled`): pause one feed or one destination.

Adding a new plugin type is ~80 lines and zero UI work. Adding an instance is pure UI.

Rejected: runtime-installable plugins from the UI. That needs sandboxing (WASM or subprocess),
a versioned ABI, and capability grants. For a single-tenant self-hosted app the plugin author
is the operator, so isolation buys nothing and costs a lot.

Pattern: **Registry + Strategy with self-describing manifests.** Use it when you have N variants
of one operation, each needing different config, and the UI must not know about any of them.

### 2. NotebookLM is one renderer, not the spine
NotebookLM was rebranded to **Gemini Notebook** in July 2026. There are two ways in, and v1 uses
the worse one on purpose.

**v1: `notebooklm-py`, unofficial.** A reverse-engineered client driving a consumer Google
account via a long-lived master token. It will break without warning, it is quota-limited, and
audio generation takes minutes.

The account on hand is the **Pro** tier (included with Google AI Pro). Reported consumer limits:

| Tier | Audio overviews/day | Notebooks | Sources/notebook | Chats/day |
|---|---|---|---|---|
| Free | 3 | 100 | 50 | 50 |
| Plus | 6 | 200 | 100 | 200 |
| **Pro** | **20** | **500** | **300** | **500** |
| Ultra | 100-200 | 500 | 500-600 | 2,500-5,000 |

20 audio overviews/day is comfortably above what this app needs (a handful of digests daily),
so quota is a guardrail here, not a binding constraint.

**Do not mirror Google's quota accounting.** Reports disagree on the reset mechanism: a rolling
24-hour window per feature (reset 24h after first use, not at local midnight) versus a
compute-based quota refreshing every few hours against a weekly ceiling. Both are unofficial
readings and either may change without notice. So the local budget is a *safety valve you
configure*, not a replica of Google's counter, and the authoritative signal is the client's own
quota-exhaustion error: on that, trip the circuit breaker and back off. Treating their error as
truth and our count as a hint is correct under every version of their rules.

**v2 target: the official Gemini Notebook Enterprise API.** Real and documented: package
`google.cloud.notebooklm.v1alpha` on `discoveryengine.googleapis.com`, with notebooks, sources,
and `notebooks.audioOverviews.create`. Auth is standard GCP; IAM role `Cloud NotebookLM User`.
Not usable here yet for three reasons:
- it requires Gemini Notebook Enterprise licences (reported 15-licence minimum at roughly
  $9/licence/month, no public self-serve price)
- its notebooks live in a GCP project data store, so a consumer Gemini subscription does not
  reach them
- `v1alpha`, Preview, pre-GA terms

**Consequence for the sidecar.** The Python sidecar exists for exactly one reason: `notebooklm-py`
is Python. The Enterprise API is plain REST with GCP auth, callable directly from TypeScript.
So the migration path is not "port the sidecar", it is "add a second renderer and delete a
container". Keep the sidecar thin enough that this stays true.

Both paths sit behind the `Renderer` interface, alongside a plain LLM text-summary fallback.
When the unofficial client breaks, digests still ship, just without audio.

Required guardrails, not optional:
- circuit breaker + exponential backoff in the sidecar client
- a configurable safety-valve cap, evaluated against `render_log` before enqueueing
- every job idempotent via `job_key`, so a retry never double-generates
- renderer health surfaced in the UI, so a broken client is visible rather than silent

### 3. Curation before rendering
Rendering is the expensive, quota-limited step. Spending it on items you would have discarded is
the main way this app becomes annoying, so a digest is a state machine with an approval gate:

```text
items collected
      |
      v
  digest DRAFT  (candidate item set, editable in the UI)
      |
      +-- curation = auto ----> APPROVED immediately
      +-- curation = manual --> waits: you pick items, then hit Render
      |
      v
  RENDERING --> READY --> delivered to each enabled sink
      |
      +--> FAILED (retryable; idempotent via job_key)
```

`curation` is a per-source setting with a global default, so a noisy feed can be manual while a
trusted one runs unattended. Manual mode is the default until you trust a source.

### 4. Storage: local disk is the store, Telegram is a sink
Telegram bot limits are asymmetric: `sendAudio` uploads up to 50 MB, but `getFile` only serves
downloads up to 20 MB. Using Telegram as the blob store therefore breaks silently for longer
podcasts (a 40-minute episode at 96 kbps is roughly 28 MB) whenever the app tries to read the
file back for in-app playback.

So artifacts live on a mounted volume (`data/`), the DB stores the path, and Telegram is a
delivery sink that receives a copy. Both behaviors work, neither is crippled.

### 5. LLM access: API keys, not subscriptions
Claude Pro/Max and Gemini Advanced are consumer chat products. Neither grants programmatic API
access; both APIs are billed separately. Claude Code can authenticate with a Pro/Max
subscription, but that entitlement covers interactive development, not a backend service, so it
is explicitly not used here.

The volume makes this a non-issue. Roughly 30 items/day at ~2K tokens each, summarized to ~400
tokens, is about 1.8M input and 0.36M output tokens per month: a few dollars on Claude Haiku
4.5, and roughly half that through the Batch API, which fits because digests are scheduled and
nobody is waiting on them. Do not distort the architecture to avoid a bill this size.

Default: the Gemini API free tier (an AI Studio key, distinct from a Gemini Advanced
subscription). The provider is a config field on the `llm-text` renderer rather than a
hardcoded choice, so switching is a dropdown:

```ts
configSchema: z.object({
  provider: z.enum(["gemini", "anthropic", "ollama"]),
  model: z.string(),
  apiKey: z.string().optional(),   // omitted for ollama
  prompt: z.string().default(DEFAULT_SUMMARY_PROMPT),
})
```

Use the Vercel AI SDK for a single interface across providers. Ollama runs as an optional
compose service for a zero-key, zero-quota, zero-bill local option.

Net shape: NotebookLM (a consumer Google account via the unofficial client) carries the
expensive audio work; the cheap text path runs on a real API.

### 6. YouTube is v2
Channel RSS feeds cap at the last 15 videos, and NotebookLM's YouTube ingestion silently fails
on videos without captions. RSS first, prove the pipeline, then add YouTube (probably with our
own transcript fetching rather than relying on NotebookLM's ingestion).

### 7. Workers run in their own process
pg-boss consumers do not run inside the Next.js server. Next's server is not a job host
(module reloading in dev, multiple instances, lifecycle assumptions). A separate `worker/`
container shares the `app/` codebase and imports the same plugin registry.

### 8. The Python sidecar is an adapter, not a tier
It exists only because `notebooklm-py` has no JS equivalent. It must contain zero business
logic. If logic starts accumulating there, the design has drifted.

## Architecture

```text
                    +--------------+
  browser --------> |  app/        |  Next.js 15: UI + API routes + audio player
                    |  (Next.js)   |
                    +------+-------+
                           | shared code: db schema, plugin registry
                    +------+-------+
                    |  worker/     |  pg-boss consumers + cron schedules
                    +--+--------+--+
                       |        |
             +---------+        +----------+
             v                             v
      +-------------+              +---------------+
      | postgres    |              | sidecar/      |  FastAPI -> notebooklm-py
      | data + jobs |              | (adapter)     |
      +-------------+              +---------------+
             |
             v
      +-------------+
      | data/ volume|  rendered artifacts (mp3, text)
      +-------------+

Pipeline:
  Source plugin -> normalize -> dedup -> keyword filter -> DRAFT digest
       (pluggable)
                                              |
                              curation gate (auto | manual)
                                              |
                                              v
                         Renderer plugin -> artifact -> Sink plugins
                            (pluggable)                  (pluggable)
```

## Directory structure
Polyglot monorepo. Paths are relative; do not hardcode an absolute home directory.

```text
distiller/
├── app/                    # Next.js 15, React, Tailwind, Drizzle ORM (pnpm)
│   ├── src/
│   │   ├── db/             # schema.ts, migrations/
│   │   ├── plugins/
│   │   │   ├── types.ts    # SourcePlugin, RendererPlugin, SinkPlugin
│   │   │   ├── registry.ts # single source of truth for available plugins
│   │   │   ├── sources/    # rss.ts
│   │   │   ├── renderers/  # notebooklm.ts, llm-text.ts
│   │   │   └── sinks/      # telegram.ts
│   │   └── app/            # routes + UI
│   └── Dockerfile
├── worker/                 # pg-boss consumers, imports from app/
│   └── Dockerfile
├── sidecar/                # Python FastAPI, notebooklm-py
│   ├── requirements.txt
│   ├── main.py
│   └── Dockerfile
├── data/                   # gitignored: rendered artifacts
├── nlm_auth/               # gitignored: master_token.json, mounted, never baked into an image
├── docker-compose.yml
└── init.md
```

## Plugin contracts

```ts
// app/src/plugins/types.ts

export interface PluginManifest<C> {
  id: string;                        // "rss" | "notebooklm" | "telegram"
  label: string;
  configSchema: z.ZodType<C>;        // drives the UI form AND server-side validation
  validate?(cfg: C): Promise<{ ok: boolean; message?: string }>;  // "Test" button
}

export interface NormalizedItem {
  externalId: string;        // stable per source; the dedup key
  url: string;
  title: string;
  publishedAt: Date;
  body?: string;
  raw: unknown;
}

export type Cursor = { etag?: string; lastModified?: string; pageToken?: string };

export interface SourcePlugin<C = unknown> extends PluginManifest<C> {
  kind: "source";
  capabilities: { pollable: boolean; supportsCursor: boolean };
  fetch(cfg: C, cursor: Cursor | null): Promise<{
    items: NormalizedItem[];
    cursor: Cursor | null;           // conditional GET: be a polite HTTP citizen
  }>;
}

export interface Artifact {
  kind: "text" | "audio";
  mime: string;
  path?: string;             // relative to the data/ volume, for binary artifacts
  text?: string;
}

export interface RendererPlugin<C = unknown> extends PluginManifest<C> {
  kind: "renderer";
  produces: { text: boolean; audio: boolean };
  dailyBudget?: number;              // null = unmetered; local safety valve, checked vs render_log
  render(cfg: C, items: NormalizedItem[], jobKey: string): Promise<{
    summary: string;
    artifacts: Artifact[];
  }>;
}

export interface SinkPlugin<C = unknown> extends PluginManifest<C> {
  kind: "sink";
  accepts: Array<Artifact["kind"]>;  // telegram: ["text", "audio"]
  deliver(cfg: C, digest: DigestView, artifacts: Artifact[]): Promise<{
    externalRef?: string;            // telegram message id / file_id, for traceability
  }>;
}
```

Dedup key: unique index on `(source_id, external_id)`. Job idempotency: `job_key`, stored on the
digest row so a retry resumes instead of duplicating upstream work. Deliveries are tracked
per sink so a partial failure retries only the sink that failed.

## Database schema (outline)
- `settings` (singleton) - default_schedule, default_curation_mode, retention_days (default 30)
- `plugin_settings` - plugin_id, kind, enabled  (type-level toggle)
- `sources` - id, plugin_id, label, config (jsonb), enabled, schedule, curation_mode,
  cursor (jsonb), last_polled_at, last_error
- `items` - id, source_id, external_id, url, title, published_at, body, raw (jsonb);
  unique(source_id, external_id)
- `keywords` - id, term, mode (include|exclude), source_id nullable for global rules
- `digests` - id, job_key (unique), renderer_id, status
  (draft|approved|rendering|ready|failed), summary, error, created_at, rendered_at
- `digest_items` - digest_id, item_id, included (bool)   -- curation lives here
- `artifacts` - id, digest_id, kind, mime, path, bytes, created_at
- `sinks` - id, plugin_id, label, config (jsonb), enabled
- `deliveries` - digest_id, sink_id, status, external_ref, error, attempted_at
- `render_log` - id, renderer_id, digest_id, created_at  -- one row per render attempt

`render_log` is a timestamped event log, not a date-keyed counter, because the external quota
window is uncertain (rolling 24h vs weekly compute budget) and may change. A log answers any
window question with a `WHERE created_at > now() - interval '...'`; a `(day, count)` aggregate
answers exactly one and silently misreports under a rolling window. When the definition of the
window belongs to someone else, store events and aggregate at read time.
- pg-boss owns its own schema in the same database

## Settings, secrets, retention

**Schedules are settings, not constants.** A global `default_schedule` lives in `settings`;
each source may override it. Both are cron expressions handed to pg-boss. Changing a schedule
in the UI reschedules the job, it does not require a restart.

**Secrets** come from the environment first, with a mounted file as the fallback for the
NotebookLM token (which is a file by nature). `.gitignore` covers `nlm_auth/`, `data/`, `.env`,
`*.token.json` from the first commit, before any real token exists. Nothing secret is ever
copied into a Docker image layer.

**Retention** defaults to 30 days, configurable in the UI. A nightly job prunes artifacts and
their DB rows past the window. Digest text is kept longer than audio by default, since it is
tiny and audio is what actually fills the disk.

## Observability
Not optional, and cheap if done from day one:
- structured JSON logging (pino in Node, structlog in Python) with a correlation id threaded
  from job to sidecar call
- `GET /health` on app, worker, and sidecar; compose healthchecks wired to them
- a **Runs** page in the UI reading pg-boss job state plus `sources.last_error`, so "why did
  nothing show up this morning" is one click, not a `docker logs` session
- renderer health and today's budget consumption shown on the dashboard

## Implementation phases

### Phase 0: Compose and database first
1. `docker-compose.yml` with the `db` service only.
2. `.gitignore` and `.gitattributes` (`* text=auto`, `*.sh eol=lf`).
3. Next.js app in `app/` via pnpm, Drizzle configured, first migration applied.

Rationale: dockerizing last is how you discover on day 20 that the build assumed a local pnpm store.

### Phase 1: Plugin core and ingestion
1. `plugins/types.ts` + `registry.ts`, with type-level enable/disable.
2. `sources/rss.ts` with conditional GET via ETag / Last-Modified.
3. Ingest path: fetch -> normalize -> dedup upsert -> keyword filter -> DRAFT digest.
4. pg-boss in `worker/`, cron per enabled source, schedule read from settings.

### Phase 2: Curation and renderers
1. Digest state machine and the curation gate (auto vs manual).
2. `renderers/llm-text.ts` first. It is the fallback, and it proves the interface without the
   fragile dependency.
3. `sidecar/` FastAPI adapter: `POST /notebooks`, `POST /notebooks/{id}/sources`,
   `POST /notebooks/{id}/ask`, `POST /notebooks/{id}/audio`, `GET /notebooks/{id}/audio`,
   plus `GET /health`.
4. `renderers/notebooklm.ts` with circuit breaker, backoff, and budget check.

### Phase 3: Sinks
1. `sinks/telegram.ts`: sends summary text plus the audio file, records `externalRef`.
2. Per-sink delivery tracking and retry.

### Phase 4: UI
1. Auth. Even single-user needs a password; there is a Google master token behind this app.
2. Sources page: plugin catalog with type toggles, schema-generated config forms, Test button,
   per-instance enable/disable, schedule and curation mode.
3. Keywords page.
4. Digests page: draft review with per-item include checkboxes, Render button, status.
5. Persistent global audio player reading from `data/`.
6. Settings page: default schedule, default curation mode, retention days.
7. Dashboard: stats, renderer health, budget used today, Runs view.

### Phase 5: Operations
1. Retention job.
2. Backup note for the Postgres volume and `data/`.

## Development environment: WSL2, decided
One contributor is on Windows, one on macOS, deployment is Linux. Rather than supporting three
platforms, the Windows side develops inside **WSL2**. That makes every developer environment
POSIX, so paths, line endings, file permissions, and Docker volume mounts behave identically
everywhere. Docker Desktop uses the WSL2 backend and `docker` runs natively inside the distro.

**The repo must live in the WSL filesystem, not under `/mnt/c`.** Concretely: clone to something
like `~/code/distiller` inside the distro, not the current OneDrive path. Two hard reasons:

- Crossing the 9p filesystem boundary makes `pnpm install` and Next.js dev builds several times
  slower, and inotify file watching does not propagate reliably, so hot reload silently stops.
- OneDrive will try to sync `node_modules/`, `data/`, and `.next/`, which at best wastes quota
  and at worst corrupts the tree mid-write.

Repo hygiene that follows from this decision:
- `.gitattributes` with `* text=auto` and `*.sh eol=lf`, so a stray CRLF never breaks a container
  entrypoint (the classic `exec /app/entrypoint.sh: no such file or directory`).
- `.editorconfig` with `end_of_line = lf`.
- Named Docker volumes for `node_modules` in dev compose, so host and container never share one.
- `git config core.autocrlf false` inside WSL.

The macOS contributor needs no special setup. The only platform-specific note is that on Apple
silicon the Python sidecar image should be built multi-arch or pinned to `linux/amd64` if any
dependency lacks an arm64 wheel.

## NotebookLM master token
Run this once on a local machine, not on the server.

1. `python3 -m venv nlm-env && source nlm-env/bin/activate`
2. `pip install "notebooklm-py[android]"`
3. `notebooklm login --master-token --account your-google-email@gmail.com`
4. The token lands in `~/.notebooklm/profiles/default/master_token.json`.
5. Copy it to `./nlm_auth/profiles/default/master_token.json` and mount that directory read-only
   into the sidecar.

## Open risks, tracked deliberately
- `notebooklm-py` breaks on any Google-side change. Mitigation: the `llm-text` fallback, and the
  official Gemini Notebook Enterprise API as the v2 escape hatch if licences ever become
  available (which would also let the Python sidecar be deleted).
- Automating a consumer Google account carries account-suspension risk. Use a dedicated account.
- Audio Overview quotas are undocumented, disputed, and change. Mitigation: `render_log` as a
  configurable safety valve, the client's own quota error as the authoritative signal, plus the
  manual curation gate, which stops junk from consuming the quota at all.
- Telegram `getFile` caps downloads at 20 MB. Mitigation: disk is the store, Telegram is a sink.
- Feed publishers rate-limit aggressive pollers. Mitigation: conditional GET plus sane schedules.
