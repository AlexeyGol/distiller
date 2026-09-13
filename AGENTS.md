# AGENTS.md

Instructions for AI coding agents working on Distiller. Tool-agnostic: Claude Code,
Cursor, Codex and others should all read this file. `CLAUDE.md` points here.

Read this before running any command. The environment section is not boilerplate -
getting it wrong produces silent data corruption, not an error message.

---

## 1. Environment: the project MUST live in the WSL ext4 filesystem

**Do not run `npm install` (or any install) from a `/mnt/c` path.** The Windows 9p
mount silently truncates binary files during extraction. The failure does not look
like a filesystem problem; it looks like a corrupt npm package:

```
SyntaxError: Unexpected token '}'   at esbuild/install.js:2
```

and a different file corrupts on each attempt. An esbuild binary that should be
9.6 MB arrives as 16 KB and fails with `Exec format error`. Diagnosing this from
the symptom wastes an hour, so it is written down here.

| Purpose | Path |
| --- | --- |
| Running commands (WSL) | `/home/alex/distiller-mvp` |
| File read/write from Windows tools | `\\wsl.localhost\Ubuntu\home\alex\distiller-mvp` |

Node (v20.11), npm, docker and python3 exist **only inside WSL Ubuntu 22.04**.
Windows has no `node` at all.

### Running commands

Quoting gets mangled when passing a command string through `wsl.exe`. Always write
a script and pipe it on stdin:

```bash
cat > /tmp/t.sh <<'SCRIPT'
cd /home/alex/distiller-mvp/app
npx vitest run
SCRIPT
wsl.exe -d Ubuntu bash < /tmp/t.sh 2>&1 | tr -d '\r'
```

### Git

The git worktree was created by WSL git, so its `.git` file holds a POSIX gitdir
path. **Run git from inside WSL**, not from Windows. Windows git cannot resolve
this worktree.

---

## 2. Tests

```bash
cd /home/alex/distiller-mvp/app && npx vitest run       # all TypeScript tests
cd /home/alex/distiller-mvp/app && npx tsc --noEmit     # typecheck
cd /home/alex/distiller-mvp/sidecar && python3 -m pytest -q
```

**The test suite requires no Docker, no Postgres and no network.** That is a
deliberate design constraint, and new tests must preserve it.

- Database tests use **pglite**: real Postgres compiled to WASM, running
  in-process. Use `createTestDb()` from `src/db/testing.ts`. Each call gets an
  isolated, freshly migrated database. Constraints, cascades and `ON CONFLICT`
  behave exactly as in production, so a test that proves the dedup unique index
  works is actually proving it.
- **Never hit the network in a test.** Every plugin takes its transport as an
  injectable dependency; stub `fetch` with `vi.stubGlobal` or pass a fake.
- Requiring Docker for `npm test` makes the suite unrunnable in exactly the
  situations where you most want to run it. Do not introduce that dependency.

### Verification is not optional

Do not report work as finished without pasting real command output. "Should work"
is not a result. If something cannot be verified in this environment, say so
explicitly rather than implying it passed.

---

## 3. Architecture: three plugin seams

Everything extensible goes through one of three interfaces in
`app/src/core/types.ts`. Read that file before adding anything.

| Seam | Responsibility | Lives in |
| --- | --- | --- |
| `SourcePlugin` | where items come from | `app/src/core/sources/` |
| `RendererPlugin` | items to digest content | `app/src/renderers/` |
| `SinkPlugin` | finished digest to a destination | `app/src/sinks/` |

Each plugin exports a Zod `configSchema` that drives **both** the generated UI form
and server-side validation. Instance config is stored as JSONB and validated on
read and write. Adding a plugin type should require zero UI changes.

**The registry is static and in-repo by design.** Runtime-installable plugins were
considered and rejected: they need sandboxing, a versioned ABI and capability
grants, and for a single-tenant self-hosted app the plugin author is the operator,
so isolation buys nothing. Do not add dynamic loading.

### Things that are deliberately NOT plugins

In-app audio playback is the app reading its own stored artifact. It has no config
and no alternative implementation. Resist making it a plugin.

---

## 4. Domain rules that are easy to break

These encode decisions with reasons. Changing them needs a reason at least as good.

**Dedup belongs to the database.** Items are inserted with `ON CONFLICT DO NOTHING`
against the `(source_id, external_id)` unique index. Never SELECT-then-INSERT: it
still races two concurrent workers, and the constraint cannot.

**A failing source must not poison a run.** `ingestSource` records errors on the
source row and returns them; it does not throw. One dead feed must not stop the
other twenty.

**The curation gate protects the scarce resource.** Rendering is quota-limited, so
a digest goes DRAFT -> APPROVED -> RENDERING -> READY. Never auto-render a draft
that a human has not approved unless the topic's `curationMode` is `auto`.

**Never mirror an external service's quota accounting.** The local budget is a
safety valve you configure; the upstream's own error is authoritative. On
`QuotaExhaustedError`, stop, regardless of what the local count believes.

**`render_log` is an event log, not a counter.** One timestamped row per render,
aggregated at read time. The upstream quota window is not ours to define and has
been reported as both a rolling 24h window and a multi-hour compute budget. A log
answers either question by changing the interval; a `(day, count)` aggregate
answers exactly one and silently misreports under the other.

**Only successful renders are logged.** A failed render consumed no upstream quota;
counting it would throttle us for nothing.

**The Python sidecar is an adapter, not a tier.** It exists solely because
`notebooklm-py` is Python. Zero business logic belongs there. Keeping it thin is
what makes it deletable if the official Gemini Notebook Enterprise API ever becomes
available, since that API is plain REST and callable straight from TypeScript.

**Disk is the artifact store; Telegram is a sink.** Telegram bots upload up to
50 MB but `getFile` only serves downloads up to 20 MB, so Telegram cannot be the
storage layer without silently breaking longer podcasts.

---

## 5. Lessons that cost real time here

Every item below was learned by losing an hour to it. They are recorded so the
next person does not pay again.

### Verify against the real thing, not the fixture

This is the single highest-value rule in this file. Every one of the following
passed its tests and was still wrong:

| Bug | What the tests said | What reality said |
| --- | --- | --- |
| `itemCount` always 0 | 323 tests green | the SQL compared `items.source_id` to `items.id` |
| `notebook_id` vs `id` | both suites green | the two halves never agreed on the field name |
| 30s render timeout | green | generation takes minutes, not seconds |
| one bad URL | green | it destroyed the whole digest |
| orphaned notebooks | green | four failed runs left four notebooks behind |

A query that returns a plausible value is not a query that returns a correct
one. Zero is plausible for a fresh install, which is exactly how the first one
survived. Assert values against known data, and exercise integrations against
the live service at least once before declaring them done.

### One contract test per integration boundary

The `notebook_id` / `id` mismatch is the case mocks structurally cannot catch:
each side mocked its own assumption, both were internally consistent, and the
disagreement only existed in the space between them. Wherever two components
agree on a wire format, one test must pin that format from the consumer's side.

### Transport timeouts and generation budgets are different things

A request that waits on a model is not slow, it is thinking. Sharing one
timeout with quick calls meant aborting work in progress and reporting it as
"failed to reach sidecar" - a transport error message for a patience problem,
which sends you looking in entirely the wrong place. See `DEFAULT_TIMEOUT_MS`
versus `DEFAULT_ASK_TIMEOUT_MS`.

### If you create an external resource, own its lifecycle

Every failed render used to abandon the notebook it had created. Four debugging
runs left four orphans against an account capped at 500. Create-and-forget is
only acceptable when nothing downstream is finite.

### Machine identifiers are not human-facing names

A `jobKey` is correct for a database and wrong for a title or a filename. The
first version produced `AI News [uuid:202609130049]` and
`f8f9161c-...:202609130049.mp3` - the latter containing a colon, which is an
illegal filename character on Windows and is the name Telegram displays in
chat. Keys and display names travel separately.

### Do not run destructive tests against the dev database

`TRUNCATE ... CASCADE` during a config round-trip test took out 65 ingested
items and a digest, because `topics -> digests` and `sources -> items` cascade.
The pglite harness exists precisely so destructive tests need no real database.
Point `DATABASE_URL` at a scratch database or use `createTestDb()`.

### Be a polite client of external services

Aggressive probing during development got this machine's IP throttled by both
Reddit and YouTube within minutes. Reddit allows roughly one request per minute
per feed and answers with 403 as readily as 429; YouTube starts returning 404
for valid channel IDs. Normal polling never approaches these limits - only
debugging loops do. Space out manual polls.

### `git add -A` swept junk into commits twice

`app/.next` (164 files) and `app/nlm-env` (2558 files, 219 MB) both landed in
commits because `.gitignore` did not anticipate them. **A leading slash anchors
a pattern to the repo root**, which does nothing in a monorepo: `/node_modules`
never matched `app/node_modules`. Patterns here are unanchored for that reason.

Look at what you are staging. `git status --porcelain | wc -l` before a commit
costs nothing and would have caught both.

---

## 6. Docker and compose specifics

Four things about this stack that are not obvious and have each bitten:

**Container DNS is captured at creation time.** Change networks or routers and
existing containers keep resolving against the old gateway. musl (alpine)
queries every nameserver in parallel and survives it; glibc (these debian
images) tries them sequentially and fails with `EAI_AGAIN`. The symptom is that
`docker run alpine` works while every app container fails, which makes the
network look healthy. Hence the explicit `dns:` entries.

**The sidecar runs as the host uid.** Its credentials are mode 700/600 owned by
the host user, which is correct for a Google master token. Running as the image's
own uid 10001 meant it could not read its own mount.

**The sidecar port is published on 127.0.0.1 only.** It has no auth of its own
and drives a real Google account. It is published at all only so `npm run dev`
on the host can reach it; inside compose, services use `http://sidecar:8000`.

**Migrations run as their own service.** `app` and `worker` wait on
`service_completed_successfully`, so a fresh host needs no manual step. Without
it the stack starts happily against an empty database and fails at the first
query, far from the cause.

---

## 7. Code style

- **Plain dashes `-` only. Never em dashes.** In code, comments, docs and commit
  messages.
- Comments explain **why**, not what. The code already says what.
- Imports use explicit `.js` extensions: `import type { X } from "../core/types.js"`.
- TypeScript `strict` is on. Do not add `any` to silence an error; fix the type.
- Match the surrounding file's conventions over any general preference.

---

## 8. Working boundaries

When several agents work in parallel, each owns a directory. Do not edit files
outside your assignment. If you need a change in someone else's file, report it
rather than making it.

Shared foundation files that individual agents must NOT edit unless that is
explicitly the task: `app/src/core/types.ts`, `app/src/core/registry.ts`,
`app/src/core/filter.ts`, `app/src/db/schema.ts`.

---

## 9. Secrets

The NotebookLM master token is a real credential for a real Google account.
`nlm_auth/`, `data/`, `.env` and `*.token.json` are gitignored, and nothing secret
may be baked into a Docker image layer. Never commit a token, never echo one into
logs, and never paste one into a report.
