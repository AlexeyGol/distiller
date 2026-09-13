# Distiller

Self-hosted digest builder. Polls RSS feeds and YouTube channels/searches,
filters items by keyword into **topics**, and renders each topic into a text
summary and an audio podcast via NotebookLM (Gemini Notebook).

One topic is one podcast feed.

```
Source plugin -> normalize -> dedup -> keyword filter -> DRAFT digest
                                              |
                               curation gate (auto | manual)
                                              v
                          Renderer plugin -> artifacts -> Sink plugins
```

## What makes it extensible

Three plugin seams, each self-describing via a Zod schema so the UI renders
config forms without knowing any concrete plugin. Adding a plugin type means
adding one file and listing it in its directory index - no UI changes.

| Seam | Built in | Directory |
| --- | --- | --- |
| Source | `rss`, `reddit`, `hackernews`, `youtube-channel`, `youtube-search` | `app/src/core/sources/` |
| Renderer | `llm-text`, `notebooklm-text`, `notebooklm` | `app/src/renderers/` |
| Sink | `telegram` | `app/src/sinks/` |

The `rss` source covers far more than its name suggests. TLDR
(`tldr.tech/api/rss/{tech,ai,devops}`), Lobsters, Mastodon hashtags, GitHub
releases, Google News queries and arXiv are all plain feeds - paste the URL, no
plugin required. See [TODO.md](./TODO.md) for the verified list.

Renderers are ordered cheapest-first. `notebooklm-text` exists because an audio
overview costs one of 20 per day and takes minutes, while asking NotebookLM a
question costs one of roughly 500 and returns in seconds - so a source-grounded
summary no longer requires generating a podcast you did not want.

Plugins toggle at two levels: the **type** (hides from the catalog, pauses all
instances, keeps config) and the **instance** (pause one feed or destination).

## Quick start

```bash
cp .env.example .env        # set APP_PASSWORD at minimum
docker compose up -d db
cd app && npm ci && npm run db:migrate
docker compose up -d
```

Then open http://localhost:3000.

## NotebookLM credentials

The `notebooklm` renderer drives a real consumer Google account through an
unofficial client, so it needs a token generated once on a machine with a
browser:

```bash
python3 -m venv nlm-env && source nlm-env/bin/activate
pip install "notebooklm-py[android]"
notebooklm login --master-token --account you@gmail.com
```

Copy the resulting profile directory to `./nlm_auth/profiles/default/`. It must
contain **both** `storage_state.json` and `master_token.json` - the client loads
the former and the brief's original assumption that the master token alone was
enough turned out to be wrong.

`nlm_auth/` is gitignored and mounted read-only. Never bake it into an image.

The account tier sets the ceiling: NotebookLM **Pro** allows 20 audio overviews
per day. The `notebooklm` renderer declares `dailyBudget: 20` as a local safety
valve, but the upstream's own quota error is always treated as authoritative.

## Running without NotebookLM

`llm-text` is the fallback renderer and has no exotic dependencies. It supports
`gemini`, `anthropic` and `ollama` through one config field, so a topic can
produce text digests even when the unofficial client breaks. Gemini's AI Studio
free tier is ample at this volume.

## Tests

```bash
cd app     && npx vitest run       # 402 tests
cd app     && npx tsc --noEmit
cd sidecar && python3 -m pytest -q # 27 tests
```

**No Docker, no Postgres and no network required.** Database tests run real
Postgres in-process via pglite, so unique indexes, cascades and `ON CONFLICT`
are genuinely exercised rather than mocked. Plugin tests inject their transport
and stub `fetch`.

## Development environment

This project must be developed inside **WSL2 on the Linux filesystem**, not on
`/mnt/c`. The 9p mount silently truncates binaries during `npm install`, which
surfaces as bogus syntax errors in package install scripts rather than as an I/O
error. See [AGENTS.md](./AGENTS.md) for the full detail and the exact symptoms.

AI coding agents should read [AGENTS.md](./AGENTS.md) before running anything.

Known gaps, planned work and decisions already settled are in
[TODO.md](./TODO.md).

## Design decisions worth knowing

- **Dedup is a database constraint**, not a SELECT-then-INSERT, which would
  still race two workers.
- **A digest is a state machine** (DRAFT -> APPROVED -> RENDERING -> READY). The
  approval gate exists because rendering is the quota-limited step; curating
  first stops junk from consuming it.
- **`render_log` is an event log**, not a date-keyed counter, because the
  upstream quota window is not ours to define and has been reported as both a
  rolling 24h window and a multi-hour compute budget.
- **Disk is the artifact store; Telegram is a sink.** Telegram bots upload up to
  50 MB but `getFile` only serves downloads up to 20 MB.
- **The Python sidecar is an adapter**, existing only because `notebooklm-py` is
  Python. Keeping it free of business logic is what would make it deletable if
  the official Gemini Notebook Enterprise API ever became reachable, since that
  API is plain REST.
- **The worker is a separate process** from Next.js, which is not a job host.

## Layout

```
app/       Next.js 15 + plugins + pipeline + worker  (TypeScript, ESM)
  src/core/      plugin contracts, registry, keyword filter, source plugins
  src/db/        Drizzle schema, migrations, pglite test harness
  src/pipeline/  ingest, digest lifecycle
  src/renderers/ llm-text, notebooklm
  src/sinks/     telegram
  src/worker/    pg-boss wiring + job bodies
sidecar/   FastAPI adapter over notebooklm-py  (Python)
data/      rendered artifacts (gitignored)
nlm_auth/  NotebookLM credentials (gitignored)
```
