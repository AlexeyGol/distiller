# Adversarial review of `feat/mvp` (PR #1)

Date: 2026-09-13. Scope: the whole branch as of `4ddb5da`, read file by file,
plus a local run of the suite. Line numbers refer to that commit.

Verified locally on macOS, Node 22.14: `npm ci`, `npx tsc --noEmit` clean,
`npx vitest run` 24 files / 469 tests green in 36s. The Python sidecar was
read but not executed. Nothing below was run against NotebookLM, Telegram or
a real LLM provider - which, as TODO.md already says, is also true of the
branch itself for everything except the NotebookLM text path.

Two of the findings were confirmed against `node_modules/pg-boss` source, not
inferred from the docs.

---

## What is good

Said first so the rest reads in proportion.

- **The tests are real.** pglite runs actual Postgres, so the unique index,
  the cascades and `ON CONFLICT` are exercised rather than mocked. That is why
  469 tests can run without Docker or network and still mean something.
- **Errors are classified, and behaviour branches on the class.**
  `QuotaExhaustedError` / `TransientError` / plain `Error` carry through from
  plugin to worker. The sidecar maps `notebooklm-py` exceptions by class name
  across the MRO (`sidecar/errors.py`) so the adapter and its tests survive the
  library being missing or reshuffled. That is a good trick.
- **Logic and glue are separated.** `worker/jobs.ts` does not know pg-boss
  exists; `app/actions.ts` is a thin form parser over `lib/mutations.ts`;
  every plugin takes its transport by injection.
- **Path traversal is handled properly** in `lib/artifacts.ts` and
  `worker/index.ts removeArtifactFile` - `root + sep`, not a naive
  `startsWith`.
- **Env references** (`${VAR}` in plugin config) are the right answer to
  "secrets in the database", and export redacts by default.
- The comments explain *why*, and `AGENTS.md` section 5 records mistakes with
  their cost. That is culture, not documentation.

---

## Blocking - fix before this runs unattended

### 1. Only one topic is ever scheduled

`app/src/worker/index.ts:121` calls `boss.schedule(QUEUE.topicCycle, schedule,
{ topicId })` once per topic. In pg-boss 10 the `schedule` table is keyed on
the queue name alone:

```
-- node_modules/pg-boss/src/plans.js:151
CREATE TABLE ${schema}.schedule (
  name text REFERENCES ${schema}.queue ON DELETE CASCADE,
  ...
  PRIMARY KEY (name)
)

-- node_modules/pg-boss/src/plans.js:443
INSERT INTO ${schema}.schedule (name, cron, timezone, data, options)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (name) DO UPDATE SET cron = ..., data = ...
```

Every call overwrites the previous one. With N topics only the last one in
`scheduledTopics()` order gets a cron; the others never build a draft. The
suite does not catch it because `index.ts` is untested and the seed creates
one topic.

Fix: one queue per topic (`topic-cycle:${topicId}`, created on the fly), or a
single `topic-cycle` cron that runs every few minutes and itself finds topics
whose schedule is due.

### 2. Retention deletes the dedup memory

`app/src/worker/jobs.ts:218` runs `DELETE FROM items WHERE fetched_at <
cutoff`. The unique index `(source_id, external_id)` is the only record of
"we have seen this". A low-volume feed whose entries are all older than
`retentionDays` loses every row; the next time the feed changes (anything but
a 304) the same entries come back, insert as new, pass the keyword filter and
land in a fresh draft as today's news.

Second effect: `digest_items` cascades from `items`, so old digests lose
their item list and `itemCount` reads 0 in history.

Fix: never delete `items` rows. Null out `body` and `raw` past the window
(that is where the bytes are) and keep the key. Or keep a tombstone table of
`(source_id, external_id)`.

### 3. The Render button renders inside an HTTP request

`app/src/app/actions.ts:500` calls `renderDigest()` directly in a Server
Action. For the audio renderer that is up to 3 min (sources) + 10 min (ask)
+ 15 min (poll) inside one Next.js request. Behind Cloudflare or any proxy
the connection drops at ~100s; the promise keeps running server-side, the UI
shows an error, and the digest sits in `rendering` until the render finishes
or the process restarts.

The `render-and-deliver` queue exists in the worker with a consumer
(`worker/index.ts:92`) and **has no producer** - there is no `boss.send` in
`app/src`. The design note "Next is not a job host" is right; the longest job
in the system currently lives in Next.

Fix: the action approves and enqueues (`boss.send("render-and-deliver",
{ digestId })`); the page shows status and polls or refreshes.

### 4. `/api/health` does not exist

`app/Dockerfile:34` probes `http://localhost:3000/api/health`. There is no
such route under `app/src/app`. It reports healthy by accident: the
middleware redirects the unknown path to `/login`, `fetch` follows the
redirect, `/login` is 200, `r.ok` is true. Unset `APP_PASSWORD` and the probe
gets a 404 and the container is unhealthy. TODO.md's "all four services come
up healthy" is true, but not for the reason it implies.

Fix: a real `app/api/health/route.ts` that pings the database, listed in
`PUBLIC_PREFIXES` in `lib/auth.ts`.

### 5. Postgres is published on all interfaces with a default password

`docker-compose.yml:19`: `- "${POSTGRES_PORT:-5432}:5432"`. Without a
`127.0.0.1:` prefix Docker binds `0.0.0.0` and, on Linux, inserts its own
iptables rules ahead of ufw. Default credentials are `distiller:distiller`.
The sidecar block has a paragraph explaining exactly this hazard and binds
loopback; the database does not.

Fix: `"127.0.0.1:${POSTGRES_PORT:-5432}:5432"`, or do not publish it at all.

---

## Serious - will bite within the first month

### Digests stuck in `rendering`

Worker restart or crash mid-generation leaves the digest in `rendering`
forever. `renderDigest` only accepts `approved | failed`
(`pipeline/digest.ts`). Needs a reaper: `rendering` older than N minutes ->
`failed`, on the retention cron or at worker boot.

### Double render race

`pipeline/digest.ts:258`: the status check and the `UPDATE ... rendering` are
two statements with no lock. A cron cycle on an auto topic plus a click on
Render (or a double click) both pass the check and both render - two audio
overviews, two of the twenty daily. Fix with a compare-and-swap:

```sql
UPDATE digests SET status = 'rendering'
WHERE id = $1 AND status IN ('approved', 'failed')
RETURNING id
```

and render only if a row came back.

### A budget-skipped digest is lost

Auto topic, `renderDigest` returns `skipped` (local budget hit). The digest
stays `approved`. The next cycle builds a *new* draft from *new* items
(`selectCandidateItems`, `digest.ts:469`, excludes anything already in a
digest); nothing ever comes back for the `approved` one, so its items never
reach a sink. The cycle needs a "render pending approved digests" step before
it builds a new draft.

### Idempotency by `jobKey` is declared, not implemented

`core/types.ts RenderInput.jobKey` promises "a retry with the same jobKey
must not produce a second upstream artifact". The sidecar receives `jobKey`
in the create body and ignores it - `sidecar/schemas.py:8
CreateNotebookRequest` has only `title`. Every retry creates a new notebook
and a new audio generation. The comment on `notebookTitle()` admits this
honestly; the contract in `types.ts` still promises the opposite. Either
implement it (sidecar looks up an existing notebook by title before creating)
or change the contract to say what is true.

### Notebooks are never deleted after success

`renderers/notebooklm.ts:413` discards the notebook only on failure inside
`createAndSummarise`. A successful audio render leaves the notebook behind.
The audio stage (`:542 pollForAudio`) is outside that try/catch, so a poll
timeout also leaves one. NotebookLM caps an account at 500 notebooks; three
daily topics reach it in about five months. Delete after the mp3 is on disk,
or have retention delete notebooks older than N days via the sidecar.

### A failed audio generation looks like a slow one

`sidecar/main.py:173 get_audio` answers 202 until an artifact is in
`_READY_STATES`. If NotebookLM marks the generation failed, the sidecar never
says so; Node polls for `maxPollMs` (15 min) and then throws a
`TransientError` saying "still pending", which is wrong and sends the
operator to look at timeouts. Map the failed states to a 502 with the reason.

### The keyword filter does not know Cyrillic

`core/filter.ts:38-39` uses `\b` and `\w`, which in JavaScript without the
`u` flag are ASCII-only. For a term like `нейросети` neither boundary is
added, so it matches as a bare substring; `ИИ` matches inside `линии` and
`Индии`. For any non-English topic the filter is a substring search. Fix:

```ts
new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu")
```

There are no non-ASCII cases in `filter.test.ts`; add some.

### Feed fetches have no timeout, and run one at a time

`core/sources/feed-http.ts:57`: `fetch(url, ...)` with no `AbortSignal`. One
hung host holds the `poll-all` job for undici's default five minutes.
`pipeline/ingest.ts:132` polls sources sequentially, so twenty feeds with two
slow ones is a ten-minute poll. `AbortSignal.timeout(30_000)` and a bounded
`Promise.allSettled` (concurrency 4-5) fix both.

### pg-boss job expiration vs a 28-minute render

pg-boss expires a running job after 15 minutes by default and retries it
(retry limit defaults to 2, `plans.js:892`). A long audio render inside
`topic-cycle` is therefore marked failed and re-sent while the original
handler keeps running. The second `buildDraft` is usually "no-items", but if
anything arrived in the meantime it becomes a second draft. Pass
`expireInMinutes: 60` (or more) to `createQueue` (`worker/index.ts:81`) for
the render queues.

### Telegram delivery is not idempotent per step

`sinks/telegram.ts:208`: `sendMessage` first, then the audio. If the audio
upload fails the delivery is recorded `failed`, and the retry sends the text
again. `externalRef` already holds the message id; check it before re-sending
text. Also `:150` silently truncates the summary at 4096 characters; a long
digest ends mid-sentence. Split into several messages instead.

### Manual-mode drafts multiply

Each cycle builds a new draft from whatever is new. Skip the UI for three days
and a topic has three drafts, each needing its own approval. If an open
`draft` exists for the topic, append to it instead of creating another.

### The first draft of a new topic is everything

`selectCandidateItems` has no time bound. Attach a new topic to a source
with 500 accumulated items and the first draft has 500 rows, with no
bulk-select in the UI (TODO.md knows). Bound candidates to
`fetched_at > topic.created_at` or to the last N days.

---

## Security

- **Login has no rate limit** and the comparison at `actions.ts:87` is a
  plain `!==`. Fine behind Cloudflare Access; on a bare port it is an
  unthrottled brute-force target with a 30-day session as the prize.
- **The session HMAC key is the password itself** (`lib/auth.ts`). Works for
  one user; a separate `SESSION_SECRET` would let the password change without
  invalidating sessions and keeps the password out of the signing path.
- **Secrets in JSONB are plaintext** unless env-refs are used. Documented and
  acceptable single-tenant, but a `pg_dump` in `data/backups/` is then a
  credential store and DEPLOY.md should say so.
- **`GET /api/config/export?secrets=1`** returns every credential in one
  request on the strength of the session cookie. Consistent with the above;
  it just makes the cookie a master secret.
- **The sidecar has no auth inside the compose network.** Any container on
  the network drives the Google account. Three containers today; worth a
  shared token header before there are more.

---

## Hygiene

- `docker-compose.yml` hardcodes `user: 1000:1000` and `dns: 8.8.8.8` - fixes
  for one WSL host, baked in for every host. The 12-line DNS comment is
  repeated three times; use a `x-common: &common` anchor.
- `CLAUDE.md` contains `/home/alex/distiller-mvp`, `wsl.exe` piping and Git
  Bash notes. That is one developer's environment in the repo; it belongs in
  `.claude/settings.local.json` or a gitignored `CLAUDE.local.md`.
- The production image ships devDependencies and runs the worker and
  migrations through `tsx` from `src/`. It works; it is also TypeScript in
  production and a fat image. `Dockerfile` pins Node 20 while development is
  on 22.
- `sources.label` is not unique (`db/schema.ts`), but config import matches
  sources by label. Two sources with the same label merge on import.
- `makeJobKey` is minute-granular and `job_key` is unique. Two cycles in the
  same minute throw an unhandled unique violation; the comment says they
  "collide rather than creating twin digests", which is true but reads as if
  it were handled.
- pg-boss cron runs in UTC and `tz` is never passed. `0 7 * * *` fires at
  10:00 in Kyiv and the UI does not say so.
- The README section on obtaining the master token is ~150 lines with five
  routes, one of which is "copy the cookie from DevTools". That is the
  documentation of the most fragile component, and its length is a symptom.

---

## Suggestions

### Strategic

1. **A `podcast` renderer = LLM-written two-host script + Gemini
   multi-speaker TTS.** Official API, AI Studio key, no master token, no
   Python sidecar, no notebook lifecycle, documented quotas. It drops into the
   existing `RendererPlugin` seam with zero architectural change - which is
   what the seam was built for. It does not fix the NotebookLM findings above;
   it makes most of them stop existing. Keep `notebooklm` as an optional
   renderer for people who want Google's voices.
2. **One real audio -> Telegram run before any new feature.** All five bugs in
   AGENTS.md section 5 were found that way, and "Verification debt" says no
   mp3 has ever been produced.
3. **Everything slow goes through the worker.** The UI should be the only
   producer for `render-and-deliver`; Next reports status and never waits.

### Tactical, in value order

- One queue per topic (finding 1) + `expireInMinutes: 60`.
- Compare-and-swap on status + `rendering` reaper + pick up `approved`.
- Retention nulls bodies; never deletes item rows.
- Unicode-aware filter with Cyrillic tests.
- `AbortSignal.timeout` in `conditionalGet`; parallel `ingestAll`.
- Delete the notebook after a successful audio render; sidecar returns a
  failure for failed generations instead of 202 forever.
- Real `/api/health`; loopback-bound Postgres.
- Telegram: check `externalRef` before re-sending text; split long
  summaries.

---

## Verdict

Code quality is above what an MVP usually gets, the test discipline is
excellent and the docs are honest about what has not been proven. But as
committed **it works for one topic, without audio, without Telegram, in one
container with an exposed database** - exactly the configuration that was
exercised. Findings 1-5 are the difference between a single-topic demo and a
service. All of them are hours, not days, and none needs an architectural
change. The heaviest tail of risk - notebooks, quotas, the master token,
15-minute waits - sits entirely inside NotebookLM, and it is cheaper to route
around than to harden.
